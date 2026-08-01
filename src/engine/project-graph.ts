import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";

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
 * The directory the graph belongs to, searching UPWARD from wherever the caller happens to be.
 *
 * The graph describes the PROJECT, but it was looked up relative to the agent's own working directory — and
 * every task agent works in a worktree under `.horsecode/worktrees/…`, which has no `graphify-out/`. So the
 * agents the graph exists for were the ones that could never see it: measured on a real project, the root
 * loads 55081 nodes and the task worktree loads nothing, and the tools answered "no code graph has been
 * built for this project yet".
 *
 * Bounded so a caller outside any project walks a few directories, not the whole filesystem.
 */
export function graphRoot(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, GRAPH_DIR, GRAPH_FILE))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
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
    const files = (await gitFiles(cwd)).filter((f) => CODE_EXT.test(f)).slice(0, MAX_STALE_CHECK);
    for (const f of files) {
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

function run(cmd: string, args: string[], cwd?: string, timeoutMs = 300_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...(cwd ? { cwd } : {}), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const take = (d: Buffer): void => { if (out.length < 200_000) out += d.toString(); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 1, out: e.message }); });
    child.on("close", (c) => { clearTimeout(timer); resolve({ code: c ?? 1, out }); });
  });
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
  if (r.code !== 0) return { ok: false, message: `Graph build failed: ${r.out.trim().split("\n").slice(-3).join(" ").slice(0, 300)}` };
  const g = await loadGraph(cwd);
  return {
    ok: true,
    message: `Graph built: ${g?.nodes.length ?? 0} nodes, ${g?.edges.length ?? 0} edges.`,
    nodes: g?.nodes.length ?? 0,
    edges: g?.edges.length ?? 0,
  };
}
