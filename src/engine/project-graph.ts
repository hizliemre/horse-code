import { readFile, stat } from "node:fs/promises";
import { writeAtomic } from "../session/atomic.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { stateRoot } from "./session-scope.js";

/**
 * The project's code graph: every file, class and function, and what calls, imports and contains what.
 *
 * Agents entering an existing project are otherwise blind. They can grep, but grep answers "where does this
 * string appear", not "what breaks if I change this" — and the second question is the one that matters when
 * you are fixing a bug in code you did not write.
 *
 * The graph is PRODUCED by graphify (MIT, tree-sitter AST parsing, no LLM, ~2s for a thousand nodes) and
 * CONSUMED here by reading its `graph.json` directly.
 *
 * Reading the file rather than talking to graphify's MCP server is deliberate. That server loads the graph
 * once at startup and serves it for the life of the process, so it would go stale the moment an agent wrote
 * a file — which is exactly the failure this is meant to prevent. Reading the file means the graph an agent
 * sees is always the one on disk, a rebuild is visible immediately, and no extra process or Python package
 * has to be present.
 */

export const GRAPH_DIR = "graphify-out";
export const GRAPH_FILE = "graph.json";

export interface GraphNode {
  id: string;
  label: string;
  /** Repo-relative path of the file this came from. */
  source_file?: string;
  /** "L123" as graphify writes it. */
  source_location?: string;
  community?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  source_file?: string;
  source_location?: string;
}

export interface ProjectGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  byId: Map<string, GraphNode>;
  /** Every edge touching a node, in both directions — the index the impact queries walk. */
  incident: Map<string, GraphEdge[]>;
}

export function graphPath(cwd: string): string {
  return join(cwd, GRAPH_DIR, GRAPH_FILE);
}

/** Parses graphify's node-link JSON into an indexed graph. Returns undefined when there is no graph yet. */
export function parseGraph(raw: string): ProjectGraph | undefined {
  let doc: { nodes?: unknown; links?: unknown; edges?: unknown };
  try { doc = JSON.parse(raw) as typeof doc; } catch { return undefined; }
  const rawNodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  // networkx writes "links"; the key is "edges" in some exports. Accept either rather than depending on which
  // serializer version produced the file.
  const rawEdges = Array.isArray(doc.links) ? doc.links : Array.isArray(doc.edges) ? doc.edges : [];

  const nodes = rawNodes.filter((n): n is GraphNode =>
    typeof n === "object" && n !== null && typeof (n as GraphNode).id === "string");
  const edges = rawEdges.filter((e): e is GraphEdge =>
    typeof e === "object" && e !== null
    && typeof (e as GraphEdge).source === "string" && typeof (e as GraphEdge).target === "string");

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incident = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    for (const end of [e.source, e.target]) {
      const list = incident.get(end);
      if (list) list.push(e); else incident.set(end, [e]);
    }
  }
  return { nodes, edges, byId, incident };
}

/** Loads the graph for a working directory, or undefined when none has been built. */
export async function loadGraph(cwd: string): Promise<ProjectGraph | undefined> {
  try { return parseGraph(await readFile(graphPath(cwd), "utf8")); } catch { return undefined; }
}

/** Synchronous load — used by the tools, which are called often and must not re-read on every keystroke. */
/**
 * The directory whose graph this caller should read.
 *
 * A task worktree has no graph of its own, and it must NOT reach past its session to the project root: the
 * root is a reference, and anything a run reads from outside itself is state the pull request will not carry.
 * So the lookup resolves to the session base — the one place a run owns — and stops there.
 */
export function graphRoot(cwd: string): string | undefined {
  const root = stateRoot(cwd);
  return existsSync(join(root, GRAPH_DIR, GRAPH_FILE)) ? root : undefined;
}

/**
 * Parsed graphs, keyed by file and mtime.
 *
 * Reading the file on every call is what keeps the graph honest — a rebuild is visible immediately, which is
 * the whole reason this does not talk to graphify's MCP server. But a real project's graph.json is 41 MB, and
 * re-reading and re-parsing that for every single tool call is seconds of blocking work per question. Keying
 * on mtime keeps the guarantee and pays the cost once: the moment the file changes, the entry is stale and
 * the next read rebuilds it.
 */
const cache = new Map<string, { mtimeMs: number; size: number; graph: ProjectGraph | undefined }>();

export function loadGraphSync(cwd: string): ProjectGraph | undefined {
  const root = graphRoot(cwd);
  if (root === undefined) return undefined;
  const path = graphPath(root);
  try {
    const st = statSync(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.graph;
    const graph = parseGraph(readFileSync(path, "utf8"));
    cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, graph });
    return graph;
  } catch {
    return undefined;
  }
}

export interface GraphStatus {
  built: boolean;
  nodes: number;
  edges: number;
  /** When the graph file was last written. */
  builtAt?: number;
  /** True when a tracked source file is newer than the graph. */
  stale: boolean;
  /** Up to a few files that changed since the build — what makes it stale, so the claim is checkable. */
  staleBecause: string[];
}

/** Files whose change invalidates the graph. Matches what graphify's AST extractors actually read. */
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|h|cc|cpp|hpp|cs|php|swift|kt|scala)$/;

/**
 * Tooling and vendored trees, for the "a file the graph has never seen" half of the check.
 *
 * The graph's own list covers everything it already knows; this only has to stop a NEW file in someone
 * else's directory — a skill's script, a dependency, a build artefact — from being read as the project
 * having changed.
 */
const NOT_INDEXED = /(^|\/)(dist|build|out|node_modules|vendor|coverage|graphify-out|\.[^/]+)\//;

/** Cap the staleness scan: a monorepo must not make "is the graph fresh?" expensive. */
export const MAX_STALE_CHECK = 5000;

function gitFiles(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    // `--others --exclude-standard` includes files that are new but NOT gitignored. Listing only tracked
    // files made a brand-new source file invisible to the freshness check — the exact case that matters,
    // since an agent adding a file is precisely when the graph stops describing the code.
    const child = spawn("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => { if (out.length < 4_000_000) out += d.toString(); });
    child.on("error", () => resolve([]));
    child.on("close", (c) => resolve(c === 0 ? out.split("\n").filter(Boolean) : []));
  });
}

/**
 * Reports whether a graph exists and whether the code has moved on since it was built.
 *
 * Staleness is decided by comparing modification times against tracked source files, not by trusting a
 * timestamp we wrote ourselves: the graph goes stale when someone edits code outside horse-code too.
 */
export async function graphStatus(cwd: string): Promise<GraphStatus> {
  const path = graphPath(cwd);
  if (!existsSync(path)) return { built: false, nodes: 0, edges: 0, stale: false, staleBecause: [] };

  const [g, st] = await Promise.all([loadGraph(cwd), stat(path).catch(() => undefined)]);
  const builtAt = st?.mtimeMs;
  const staleBecause: string[] = [];
  if (builtAt !== undefined) {
    /**
     * The graph's own file list decides staleness — not every code-looking file in the repository.
     *
     * Scanning by extension produced a false alarm that is worse than no alarm: on a real project the graph
     * was reported stale because of scripts under `.claude/skills/`, which graphify never indexed and whose
     * mtimes had moved when the skills were installed. The user was told to spend a rebuild on files the
     * graph does not contain and would not contain afterwards either.
     *
     * A file the graph KNOWS, changed since the build, is exactly the claim being made — and it needs no
     * guessing about which directories count as source.
     */
    const known = new Set<string>();
    for (const n of g?.nodes ?? []) if (n.source_file) known.add(n.source_file);
    // A brand-new file the graph has never seen is the other real cause, and the one that matters most when
    // an agent adds code. It only counts when it looks like something graphify would extract.
    const listed = await gitFiles(cwd);
    // NOT_INDEXED applies to BOTH halves. The graph happens to contain `.horsecode/skills/**` — horse-code's
    // own installed state, indexed because graphify walks what it is pointed at — and a change there is never
    // a reason to tell someone their CODE graph has gone out of date. Measured: the whole staleness claim on
    // a real project was three skill documents.
    const candidates = listed.filter((f) => !NOT_INDEXED.test(f) && (known.has(f) || CODE_EXT.test(f)))
      .slice(0, MAX_STALE_CHECK);
    for (const f of candidates) {
      if (staleBecause.length >= 3) break;
      try {
        const s = await stat(join(cwd, f));
        if (s.mtimeMs > builtAt) staleBecause.push(f);
      } catch { /* deleted since listing → not evidence */ }
    }
  }
  return {
    built: true,
    nodes: g?.nodes.length ?? 0,
    edges: g?.edges.length ?? 0,
    ...(builtAt !== undefined && { builtAt }),
    stale: staleBecause.length > 0,
    staleBecause,
  };
}

/**
 * Locates the Python that can import graphify.
 *
 * The `graphify` command is usually a shim installed by pipx or `uv tool`, whose interpreter is a private
 * virtualenv NOT on the system Python's import path — so `python3 -c "import graphify"` fails even though the
 * tool is installed and working. The shim's shebang names the interpreter that CAN import it, so that is what
 * we read. Falling back to `python3` covers a plain `pip install --user`.
 */
export async function graphifyPython(): Promise<string | undefined> {
  const shim = await which("graphify");
  if (shim) {
    try {
      const first = (await readFile(shim, "utf8")).split("\n", 1)[0];
      const m = /^#!\s*(\S+)/.exec(first);
      if (m && existsSync(m[1])) return m[1];
    } catch { /* not a script (a real binary) → fall through */ }
  }
  const py = await which("python3");
  if (!py) return undefined;
  return (await run(py, ["-c", "import graphify"])).code === 0 ? py : undefined;
}

function which(cmd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", `command -v ${cmd}`], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve(undefined));
    child.on("close", (c) => resolve(c === 0 && out.trim() ? out.trim() : undefined));
  });
}

/**
 * How long the build may go SILENT before it is treated as hung.
 *
 * Idle, not total. A total ceiling is a guess about repository size, and the guess was five minutes: on a
 * real project the extractor was working through 19,297 files, printing progress the whole way, and was
 * SIGKILLed at 98% — then reported to the user as "Graph build failed" followed by three progress lines,
 * which is the least informative thing the failure could possibly have said.
 *
 * A process that is still printing progress is not hung, however long it takes. One that says nothing for
 * five minutes is, whatever the repository's size.
 */
export const BUILD_IDLE_TIMEOUT_MS = 300_000;

function run(
  cmd: string, args: string[], cwd?: string, idleMs = BUILD_IDLE_TIMEOUT_MS,
): Promise<{ code: number; out: string; timedOut?: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...(cwd ? { cwd } : {}), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    let timer: NodeJS.Timeout;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, idleMs);
    };
    const take = (d: Buffer): void => {
      arm(); // any output is proof of life
      // Keep the HEAD of the stream as well as the tail: a Python traceback is printed once, at the point of
      // failure, and is then buried under thousands of progress lines.
      if (out.length < 200_000) out += d.toString();
    };
    arm();
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 1, out: e.message }); });
    child.on("close", (c) => { clearTimeout(timer); resolve({ code: c ?? 1, out, timedOut }); });
  });
}

/**
 * The part of a failed build's output worth showing.
 *
 * Progress lines are the overwhelming majority of what a build prints and they say nothing about why it
 * stopped. Lines that look like a diagnosis are pulled out first; the tail is only the fallback.
 */
export function failureReason(out: string): string {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const diagnostic = lines.filter((l) =>
    /(Traceback|Error|error:|Exception|No such file|Permission denied|MemoryError|Killed)/.test(l)
    && !/AST extraction:/.test(l));
  const pick = diagnostic.length ? diagnostic.slice(-3) : lines.slice(-3);
  return pick.join(" ").slice(0, 300);
}

export interface BuildResult {
  ok: boolean;
  message: string;
  nodes?: number;
  edges?: number;
}

/**
 * Builds (or rebuilds) the graph for `cwd`.
 *
 * Drives graphify's own incremental rebuild — the same function its post-commit hook calls. It is pure AST
 * extraction: no LLM, no API key, no network, and a SHA256 cache means a rebuild only re-parses what changed.
 * That is what makes keeping the graph fresh affordable enough to do automatically.
 */
/**
 * Strips the tooling nodes graphify picks up on its way past.
 *
 * graphify walks what it is pointed at, and what it is pointed at contains horse-code's own installed state.
 * Measured on a real project: 7,915 of 55,081 nodes — 14% — came from `.horsecode/skills`, `.claude/` and
 * `.agents/`. They are not the project. They surface in `graph_find` and `graph_overview` as if a skill
 * document were a source file, they inflate every count the user is shown, and now that the graph is
 * committed they are 14% of an artefact every clone downloads.
 *
 * Done after the build rather than by configuring graphify: the rule is ours, it has to survive whatever
 * version of the tool is installed, and it is idempotent — the next incremental build re-adds them and the
 * next prune takes them out again.
 */
export function pruneTooling(doc: Record<string, unknown>): { removed: number; kept: number } {
  const nodes = Array.isArray(doc.nodes) ? doc.nodes as { id?: unknown; source_file?: unknown }[] : [];
  const keep = nodes.filter((n) => {
    const f = typeof n.source_file === "string" ? n.source_file : "";
    return !f || !NOT_INDEXED.test(f);
  });
  const removed = nodes.length - keep.length;
  if (!removed) return { removed: 0, kept: nodes.length };

  const ids = new Set(keep.map((n) => String(n.id)));
  doc.nodes = keep;
  // An edge to a node that is gone is a dangling reference — worse than the node itself, because every
  // traversal has to guard against it.
  for (const key of ["links", "edges"]) {
    const list = doc[key];
    if (!Array.isArray(list)) continue;
    doc[key] = (list as { source?: unknown; target?: unknown }[])
      .filter((e) => ids.has(String(e.source)) && ids.has(String(e.target)));
  }
  return { removed, kept: keep.length };
}

export async function buildProjectGraph(cwd: string): Promise<BuildResult> {
  const py = await graphifyPython();
  if (!py) {
    return {
      ok: false,
      message: "graphify is not installed. `uv tool install graphifyy` (or `pipx install graphifyy`) — it is MIT, pure AST parsing, and costs no tokens.",
    };
  }
  const script = "from graphify.watch import _rebuild_code\nfrom pathlib import Path\nimport sys\nsys.exit(0 if _rebuild_code(Path('.')) else 1)\n";
  const r = await run(py, ["-c", script], cwd);
  if (r.timedOut) {
    return {
      ok: false,
      message: `Graph build stopped: it produced no output for ${Math.round(BUILD_IDLE_TIMEOUT_MS / 60_000)} minutes `
        + `and was killed. Last it said: ${failureReason(r.out)}`,
    };
  }
  if (r.code !== 0) return { ok: false, message: `Graph build failed: ${failureReason(r.out)}` };

  // Best-effort: a graph that still carries tooling nodes is worse than one that does not, but it is not a
  // reason to report the build as failed.
  let pruned = 0;
  try {
    const path = graphPath(cwd);
    const doc = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const res = pruneTooling(doc);
    if (res.removed) { await writeAtomic(path, JSON.stringify(doc)); pruned = res.removed; }
  } catch { /* leave the graph as graphify wrote it */ }

  const g = await loadGraph(cwd);
  return {
    ok: true,
    message: `Graph built: ${g?.nodes.length ?? 0} nodes, ${g?.edges.length ?? 0} edges.`
      + (pruned ? ` (${pruned.toLocaleString("en-US")} tooling node(s) left out — skills and agent state are not the project.)` : ""),
    nodes: g?.nodes.length ?? 0,
    edges: g?.edges.length ?? 0,
  };
}
