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

/**
 * The commit the graph describes, written beside it.
 *
 * Staleness used to be the graph FILE'S mtime against every source file's — and a file's mtime is "when git
 * last wrote it", not "when the graph was built". Measured after a routine `git pull`: git wrote
 * `graphify-out/graph.json` and then, 9 to 14 MILLISECONDS later, the `toucan/…` files that sort after it,
 * so a graph that had arrived in that very pull was reported out of date. Every pull, every checkout and
 * every branch switch did this, and each false alarm asked for a rebuild of 47,000 nodes.
 *
 * A commit answers the question exactly: what changed between then and now is `git diff`, and no clock is
 * involved. Shared like the graph itself, because a clone that has the graph has the same answer.
 */
export const STAMP_FILE = ".graph-commit.json";

export function stampPath(cwd: string): string {
  return join(cwd, GRAPH_DIR, STAMP_FILE);
}

interface GraphStamp { commit: string }

/** The stamp beside the graph, or undefined when there is none / it is unreadable. */
export async function readStamp(cwd: string): Promise<GraphStamp | undefined> {
  try {
    const raw = JSON.parse(await readFile(stampPath(cwd), "utf8")) as GraphStamp;
    return typeof raw.commit === "string" && raw.commit ? raw : undefined;
  } catch { return undefined; }
}

/** Runs a git command in `cwd`; empty output on any failure — a missing answer is never evidence of staleness. */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => { if (out.length < 4_000_000) out += d.toString(); });
    child.on("error", () => resolve(""));
    child.on("close", (c) => resolve(c === 0 ? out : ""));
  });
}

/** Files that changed between the stamped commit and the working tree, committed or not. */
export async function changedSince(cwd: string, commit: string): Promise<string[] | undefined> {
  const known = await git(cwd, ["cat-file", "-e", `${commit}^{commit}`]);
  if (known === undefined) return undefined;
  const reachable = await git(cwd, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]);
  if (!reachable.trim()) return undefined;           // …the stamp names a commit this checkout does not have
  const committed = await git(cwd, ["diff", "--name-only", `${commit}`, "HEAD"]);
  const working = await git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  const dirty = working.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
  return [...new Set([...committed.split("\n").filter(Boolean), ...dirty])];
}

/**
 * The community names, which the graph itself does not carry.
 *
 * graphify finds the communities without an LLM, but NAMING them is the one step that needs one — step 5 of
 * its runbook: "look at its node labels and write a 2-5 word plain-language name". The names land here, and
 * `graph.json` keeps only each node's community NUMBER.
 *
 * That difference is the whole reason this file is read. "This symbol is in community 7" is an index, and an
 * agent can do nothing with it; "this symbol is in Wallet Member & Balance" is orientation. Measured on a real
 * project: 6283 named communities, and not one of those names present anywhere in `graph.json`.
 */
export const LABELS_FILE = ".graphify_labels.json";

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
  /** Community number → the name written for it. Empty when the project has not been labelled. */
  areas: Map<number, string>;
}

export function graphPath(cwd: string): string {
  return join(cwd, GRAPH_DIR, GRAPH_FILE);
}

export function labelsPath(cwd: string): string {
  return join(cwd, GRAPH_DIR, LABELS_FILE);
}

/**
 * The area a node belongs to, by name — or undefined when it has none.
 *
 * Undefined covers three different situations that all mean the same thing to a caller: the project has no
 * names, this node was never assigned a community (graphify leaves singletons out), or the number has no name.
 * None of them is worth inventing text for, so none of them produces any.
 */
export function areaOf(g: ProjectGraph, n: GraphNode | undefined): string | undefined {
  return n?.community === undefined ? undefined : g.areas.get(n.community);
}

/**
 * The name graphify writes BEFORE anything has named the community.
 *
 * Its build seeds every community with `'Community ' + str(cid)` and the labelling step replaces the ones it
 * reaches. Measured on a real project: 6283 communities, 5057 still carrying the seed — 80%. Letting one
 * through would put "Community 4821" in front of an agent, which is the community number again with a word in
 * front of it. An area nobody named has to read as unnamed.
 */
const UNNAMED = /^community[\s_-]*\d+$/i;

/** Parses the community-name file. Junk yields no names rather than taking the graph down with it. */
export function parseAreas(raw: string | undefined): Map<number, string> {
  const out = new Map<number, string>();
  if (!raw) return out;
  try {
    const doc = JSON.parse(raw) as unknown;
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return out;
    for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
      const id = Number(k);
      if (!Number.isInteger(id) || typeof v !== "string") continue;
      const name = v.trim();
      if (name && !UNNAMED.test(name)) out.set(id, name);
    }
  } catch { /* an unnamed graph is the normal case, not an error */ }
  return out;
}

/** Parses graphify's node-link JSON into an indexed graph. Returns undefined when there is no graph yet. */
export function parseGraph(raw: string, labelsRaw?: string): ProjectGraph | undefined {
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
  return { nodes, edges, byId, incident, areas: parseAreas(labelsRaw) };
}

/**
 * Forgets the names of communities the graph no longer has.
 *
 * Every rebuild re-partitions the graph and renumbers what it finds, so a name written for community 47 may
 * afterwards belong to nothing — it stays in the file, unreachable, and the next rebuild adds more. Measured
 * on a real project before this existed: 6283 names, 2822 of them (44%) resolving to no community, in a file
 * that is committed and read by people.
 *
 * Nothing is lost by dropping them. A name that cannot be looked up describes a grouping the graph no longer
 * makes; the clusters that replaced it have their own names, written against the partition that exists.
 *
 * The guard matters more than the pruning. A rebuild that failed, or one interrupted before it assigned
 * communities, leaves a graph with none — and pruning against that would delete EVERY name in the file. An
 * LLM pass over thousands of communities is not something to lose to a build that did not finish, so a graph
 * with no communities is treated as no information rather than as "none of them exist".
 */
export async function pruneAreaNames(cwd: string): Promise<number> {
  const path = labelsPath(cwd);
  let labels: Record<string, unknown>;
  try {
    const doc = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return 0;
    labels = doc as Record<string, unknown>;
  } catch { return 0; }   // no names to prune is the normal case

  const graph = await loadGraph(cwd);
  if (!graph) return 0;
  const live = new Set<number>();
  for (const n of graph.nodes) if (n.community !== undefined) live.add(n.community);
  if (!live.size) return 0;   // a graph that assigned no communities says nothing about which names are dead

  const kept = Object.keys(labels).filter((k) => live.has(Number(k)));
  if (kept.length === Object.keys(labels).length) return 0;

  const ordered: Record<string, unknown> = {};
  for (const k of kept.sort((a, b) => Number(a) - Number(b))) ordered[k] = labels[k];
  // One key per line, in numeric order: the file is committed, so a change to one name has to be a change to
  // one line rather than to the whole document.
  await writeAtomic(path, `${JSON.stringify(ordered, null, 2)}\n`);
  return Object.keys(labels).length - kept.length;
}

/** Loads the graph for a working directory, or undefined when none has been built. */
export async function loadGraph(cwd: string): Promise<ProjectGraph | undefined> {
  try {
    // The names are optional and always have been: most graphs predate them. A missing file is not a failure.
    const labels = await readFile(labelsPath(cwd), "utf8").catch(() => undefined);
    return parseGraph(await readFile(graphPath(cwd), "utf8"), labels);
  } catch { return undefined; }
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
const cache = new Map<string, { stamp: string; graph: ProjectGraph | undefined }>();

/** mtime+size of a file, or "" when it is absent — the absence is itself a state worth noticing. */
function stampOf(path: string): string {
  try { const st = statSync(path); return `${st.mtimeMs}:${st.size}`; } catch { return ""; }
}

export function loadGraphSync(cwd: string): ProjectGraph | undefined {
  const root = graphRoot(cwd);
  if (root === undefined) return undefined;
  const path = graphPath(root);
  const labels = labelsPath(root);
  try {
    // Both files, because the names live in the second one: a cache keyed on the graph alone would keep
    // serving yesterday's names after a re-label, and re-labelling changes nothing else on disk.
    const stamp = `${stampOf(path)}|${stampOf(labels)}`;
    const hit = cache.get(path);
    if (hit && hit.stamp === stamp) return hit.graph;
    let labelsRaw: string | undefined;
    try { labelsRaw = readFileSync(labels, "utf8"); } catch { /* unnamed graph — the normal case */ }
    const graph = parseGraph(readFileSync(path, "utf8"), labelsRaw);
    cache.set(path, { stamp, graph });
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

  const known = new Set<string>();
  for (const n of g?.nodes ?? []) if (n.source_file) known.add(n.source_file);
  const counts = (f: string): boolean => !NOT_INDEXED.test(f) && (known.has(f) || CODE_EXT.test(f));

  /**
   * The stamped commit answers it exactly, and no clock is involved.
   *
   * What changed between the graph's commit and now is a `git diff`; a file's mtime is only when git last
   * wrote it. Measured after a routine pull: the graph arrived IN that pull and was reported stale because
   * git happened to write it 13 milliseconds before the source files that sort after it.
   */
  const stamp = await readStamp(cwd);
  if (stamp) {
    const changed = await changedSince(cwd, stamp.commit);
    if (changed) {
      for (const f of changed) {
        if (staleBecause.length >= 3) break;
        if (counts(f)) staleBecause.push(f);
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
  }

  // No stamp (a graph built before this existed), or a commit this checkout does not have: the older check.
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
    // A brand-new file the graph has never seen is the other real cause, and the one that matters most when
    // an agent adds code. It only counts when it looks like something graphify would extract.
    const listed = await gitFiles(cwd);
    // NOT_INDEXED applies to BOTH halves. The graph happens to contain `.horsecode/skills/**` — horse-code's
    // own installed state, indexed because graphify walks what it is pointed at — and a change there is never
    // a reason to tell someone their CODE graph has gone out of date. Measured: the whole staleness claim on
    // a real project was three skill documents.
    const candidates = listed.filter(counts).slice(0, MAX_STALE_CHECK);
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
 * The per-file traces go too, and for a sharper reason: they are horse-code's own account OF the code, so
 * indexing them as code makes the graph describe its own description. On a real project that was 2,030
 * documents feeding roughly twenty thousand nodes, none of which any question about the software is asking
 * about. The project's OWN documents stay — those are written by the team and are part of what it is.
 *
 * Done after the build rather than by configuring graphify: the rule is ours, it has to survive whatever
 * version of the tool is installed, and it is idempotent — the next incremental build re-adds them and the
 * next prune takes them out again.
 */
export function pruneTooling(
  doc: Record<string, unknown>,
  /** Exact paths to drop as well — the per-file traces, named from the index that recorded writing them. */
  alsoDrop: ReadonlySet<string> = new Set(),
): { removed: number; kept: number } {
  const nodes = Array.isArray(doc.nodes) ? doc.nodes as { id?: unknown; source_file?: unknown }[] : [];
  const keep = nodes.filter((n) => {
    const f = typeof n.source_file === "string" ? n.source_file : "";
    return !f || (!NOT_INDEXED.test(f) && !alsoDrop.has(f));
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

/**
 * Where our own per-file traces live, from the index that recorded writing them.
 *
 * The index rather than a path pattern, because the two kinds of markdown in the trace directory have to be
 * told apart exactly: an entry with a `doc` is one of the PROJECT's documents, adopted, and it belongs in the
 * graph; an entry without one is a file horse-code wrote, and it does not.
 */
async function writtenTracePaths(cwd: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const { loadTraceIndex, traceRootRel } = await import("./trace.js");
    const index = await loadTraceIndex(cwd);
    const root = traceRootRel().replace(/\\/g, "/");
    for (const [file, rec] of Object.entries(index.traces)) {
      if (!rec.doc) out.add(`${root}/${file}.md`);
    }
  } catch { /* no index yet → nothing of ours to leave out */ }
  return out;
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
    const res = pruneTooling(doc, await writtenTracePaths(cwd));
    if (res.removed) { await writeAtomic(path, JSON.stringify(doc)); pruned = res.removed; }
  } catch { /* leave the graph as graphify wrote it */ }

  // The commit this graph describes. Best-effort: a graph without a stamp still works, it just falls back to
  // the mtime check — see graphStatus.
  try {
    const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    if (head) await writeAtomic(stampPath(cwd), `${JSON.stringify({ commit: head } satisfies GraphStamp)}\n`);
  } catch { /* no stamp → the older, weaker check */ }

  /**
   * The placeholders graphify writes are not names, and this file is shared.
   *
   * A rebuild that finds new communities seeds each one "Community <n>". `parseAreas` already refuses those
   * — an area nobody named has to read as unnamed — so they carry no information, and every rebuild adds
   * more of them. Measured on a real checkout: `.graphify_labels.json` had grown to 6,334 entries of which
   * 2,896 were bare placeholders, and the file is committed, so each rebuild left it modified for the next
   * merge to trip over. Dropping them keeps a shared file stable and loses nothing.
   */
  let seeded = 0;
  try {
    const lp = labelsPath(cwd);
    const doc = JSON.parse(await readFile(lp, "utf8")) as Record<string, unknown>;
    const named = Object.fromEntries(Object.entries(doc)
      .filter(([, v]) => !(typeof v === "string" && UNNAMED.test(v.trim()))));
    seeded = Object.keys(doc).length - Object.keys(named).length;
    if (seeded) {
      const ordered: Record<string, unknown> = {};
      for (const k of Object.keys(named).sort((a, b) => Number(a) - Number(b))) ordered[k] = named[k];
      await writeAtomic(lp, `${JSON.stringify(ordered, null, 2)}\n`);
    }
  } catch { /* no labels file, or unreadable → nothing to tidy */ }

  const g = await loadGraph(cwd);
  return {
    ok: true,
    message: `Graph built: ${g?.nodes.length ?? 0} nodes, ${g?.edges.length ?? 0} edges.`
      + (pruned ? ` (${pruned.toLocaleString("en-US")} tooling node(s) left out — skills and agent state are not the project.)` : ""),
    nodes: g?.nodes.length ?? 0,
    edges: g?.edges.length ?? 0,
  };
}
