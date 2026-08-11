import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { stateRoot } from "./session-scope.js";
import { writeAtomic } from "../session/atomic.js";
import type { ProjectGraph } from "./project-graph.js";

/**
 * Traces: a short written account of what each source file IS and why it exists.
 *
 * The graph says what calls what. It cannot say what a module is FOR — which business rule it serves, what
 * would go wrong for a user if it broke. That is the half an agent entering an unfamiliar project is missing,
 * and no amount of AST parsing produces it: it takes reading the code and writing down the intent.
 *
 * So this stage costs tokens, and it is the only part of project understanding that does. It is therefore
 * never automatic — the user is shown what it will cost and asked.
 *
 * Traces are keyed by CONTENT HASH, so a re-run only pays for files that actually changed. That is what keeps
 * them affordable to maintain rather than a one-off that rots.
 */

/** Where traces live. Committed deliberately: a trace describes the code, so every clone should start with it. */
export const TRACE_DIR = join(".horsecode", "traces");

/**
 * Where traces go in THIS project, when its own documentation already has a home.
 *
 * A project that generates and maintains file-level documentation keeps it somewhere deliberate — one repo
 * has 58 subsystem traces under `docs/architecture/`, written by a generator and kept in step with the code.
 * Writing horse-code's traces into a second root would split the same kind of knowledge across two places,
 * and traces in two places are traces nobody keeps in step: a reader has to know which kind they want before
 * they can look.
 *
 * So it is configurable and the default is unchanged. Per-file traces mirror the source tree UNDER whichever
 * root is chosen, so they nest into subdirectories and never collide with documents already sitting flat at
 * its top.
 */
let traceRoot = TRACE_DIR;

/** Points traces at a project-chosen directory (repo-relative). An empty value keeps the default. */
export function setTraceRoot(rel: string | undefined): void {
  // Only a leading "./" and trailing slashes: stripping leading DOTS would turn `.horsecode/traces` into
  // `horsecode/traces` and quietly write outside every dot-directory a project might choose.
  if (rel && rel.trim()) traceRoot = rel.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

/** The active root, repo-relative — for the gitignore rules and for anything that reports where traces live. */
export function traceRootRel(): string {
  return traceRoot;
}

/** Deeper than this and a stray `index.json` is not the project's trace root, it is something else's data. */
const MAX_DISCOVERY_DEPTH = 4;

/**
 * The trace root a project already has, read from the index the traces carry.
 *
 * Where traces live is a decision about the PROJECT, but it is recorded in `.horsecode/config.json` — a file
 * that must stay out of git, because it takes the same shape as the user's own config and can therefore hold
 * an api key. So every OTHER checkout of the same repository loses the setting: a fresh clone, a colleague's
 * machine, another tool's worktree.
 *
 * Measured on a real project: a worktree reported "no per-file traces" at startup while 2,101 of them sat in
 * `docs/architecture/` beside it, committed and current. An agent asking `graph_trace` about any file there
 * would have been told there is no trace for it — the cheapest orientation the project has, invisible for
 * want of one line of configuration.
 *
 * The traces answer this themselves. Their index is committed WITH them, so it is present wherever they are,
 * and finding it is better than sharing a file that can carry a secret.
 */
export function discoverTraceRoot(cwd: string, trackedFiles: string[]): string | undefined {
  const candidates = trackedFiles
    .map((f) => f.replace(/\\/g, "/"))
    .filter((f) => f.endsWith(`/${TRACE_INDEX}`) && f.split("/").length <= MAX_DISCOVERY_DEPTH)
    // Shallowest first: a repository with two is choosing between a root and something buried in it.
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));

  for (const rel of candidates) {
    try {
      const raw = readFileSync(join(cwd, rel), "utf8");
      const doc = JSON.parse(raw) as TraceIndex;
      // An index recording nothing is a root someone set up and never used — it names no useful location.
      if (doc?.version !== 1 || typeof doc.traces !== "object" || doc.traces === null) continue;
      if (!Object.keys(doc.traces).length) continue;
      return rel.slice(0, -(`/${TRACE_INDEX}`.length));
    } catch { /* not a trace index, not on disk, or not readable — none is a reason to fail startup */ }
  }
  return undefined;
}
export const TRACE_INDEX = "index.json";

/** Extensions worth a trace — source code, not data or markup. */
export const TRACEABLE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|h|cc|cpp|hpp|cs|php|swift|kt|scala)$/;

/**
 * Whether a trace could EVER exist for this path, as distinct from not existing yet.
 *
 * `graph_trace` answered both cases the same way — "either it has none yet or the path differs" — and for a
 * file the tracer never visits, both halves are wrong. Measured on an Angular project: fifteen different
 * roles asked for the trace of the same `.html` template, each was told it might appear later, and each went
 * looking with `graph_find` before reading the file itself. Twenty-odd calls for an answer that could not
 * change.
 */
export function everTraceable(file: string): boolean {
  return TRACEABLE_EXT.test(file);
}

/**
 * Paths that are not the project's own source, however much code they contain.
 *
 * The generated/vendored names were here from the start. The DOT-DIRECTORY rule was not, and its absence was
 * expensive: measured on a real project, `git ls-files` offered 15,698 traceable files, of which 13,035 sat
 * under `.claude/worktrees.orphaned-backup/` — abandoned copies of the same code. Tracing them would have
 * spent five sixths of the run describing duplicates, and then filled the trace set with near-identical notes
 * about files nobody would ever open.
 *
 * A leading-dot directory is tooling, cache or state by universal convention — `.git`, `.venv`, `.next`,
 * `.claude`. None of it is what the project IS.
 */
const NOT_SOURCE = /(^|\/)(dist|build|out|node_modules|vendor|coverage|graphify-out|\.[^/]+)\//;

/**
 * Files a tool wrote, not a person.
 *
 * Generated code is the worst possible trace subject: it is long, it is uniform, and its content is a
 * restatement of a schema or a proto file that the trace cannot see. Measured on a real project, 107 EF Core
 * artefacts — every `*.Designer.cs` and the model snapshot — were trace candidates, and the large ones were
 * skipped only for being large, which is the right outcome reached for the wrong reason.
 *
 * Only unambiguous markers are listed. A directory named `Migrations` is a guess; a file named
 * `20260429000547_Init.Designer.cs` is not.
 */
const GENERATED = /(\.Designer\.cs|ModelSnapshot\.cs|\.(g|generated)\.(cs|ts|js)|\.d\.ts|_pb2(_grpc)?\.py|\.pb\.go)$/;

/**
 * The files a trace run should consider, from everything git reports.
 *
 * Shared by the tracer and the brief: a brief assembled from documents inside an abandoned worktree describes
 * the wrong project just as surely as a trace does.
 */
export function traceable(files: string[], opts?: { code?: boolean }): string[] {
  return files.filter((f) => !NOT_SOURCE.test(f) && !GENERATED.test(f)
    && (opts?.code === false || TRACEABLE_EXT.test(f)));
}

export interface TraceRecord {
  /** Hash of the file content the trace was written from — the trace is stale when this stops matching. */
  hash: string;
  /** Repo-relative path of the file described. */
  file: string;
  writtenAt: number;
  /** The model that wrote it, so a bad batch can be traced back. */
  model?: string;
  /**
   * A project document that already describes this file, repo-relative.
   *
   * Set instead of writing a trace of our own, when the repository has generated documentation covering the
   * file. The document is the only copy — editing it updates the trace by construction — so nothing here
   * drifts from it.
   */
  doc?: string;
}

export interface TraceIndex {
  version: 1;
  traces: Record<string, TraceRecord>;
}

/**
 * Where this caller's traces live: the session's, not the caller's own directory.
 *
 * A task worktree has no traces and must not reach past its session to the project root — the root is a
 * reference, and nothing a run reads from or writes to outside itself reaches the pull request. Same rule as
 * the graph; traces were simply missed when that was fixed.
 */
export function traceDir(cwd: string): string {
  return join(stateRoot(cwd), traceRoot);
}

/** Path of one file's trace. Mirrors the source tree so a trace is findable from the path alone. */
export function tracePath(cwd: string, file: string): string {
  return join(traceDir(cwd), `${file}.md`);
}

export function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export async function loadTraceIndex(cwd: string): Promise<TraceIndex> {
  try {
    const raw = JSON.parse(await readFile(join(traceDir(cwd), TRACE_INDEX), "utf8")) as TraceIndex;
    if (raw?.version === 1 && typeof raw.traces === "object" && raw.traces !== null) return raw;
  } catch { /* absent or unreadable → start empty */ }
  return { version: 1, traces: {} };
}

/**
 * Two versions of the index, combined — which is what a conflict on this file actually asks for.
 *
 * The index is a map from file path to the trace of that file. When two branches both write it, they are
 * almost always describing DIFFERENT files: each side traced what it changed. The union is then the exact
 * answer, and there is nothing to decide. Where both describe the same file, the later `writtenAt` wins —
 * a trace is derived from content, so the newer one was written from the newer version of that file.
 *
 * Measured on a real project: merging 225 commits of the main branch into a session branch produced exactly
 * one conflict, and it was this file — 2,522 entries on one side, 2,588 on the other, 2,589 in the union.
 * Handing that to a model means asking it to reconcile five thousand lines of machine-written JSON by hand.
 * Taking the base's copy — what every other generated file here does — would have dropped 67 traces outright
 * and kept 81 that the other side had already rewritten from newer code.
 */
export function mergeTraceIndexes(ours: TraceIndex, theirs: TraceIndex): TraceIndex {
  const traces: Record<string, TraceRecord> = { ...ours.traces };
  for (const [file, rec] of Object.entries(theirs.traces)) {
    const mine = traces[file];
    if (!mine || (rec.writtenAt ?? 0) > (mine.writtenAt ?? 0)) traces[file] = rec;
  }
  return { version: 1, traces };
}

/** Parses an index from raw text, or undefined when it is not one — a caller must not merge into garbage. */
export function parseTraceIndex(text: string): TraceIndex | undefined {
  try {
    const raw = JSON.parse(text) as TraceIndex;
    if (raw?.version === 1 && typeof raw.traces === "object" && raw.traces !== null) return raw;
  } catch { /* not JSON, or not an index */ }
  return undefined;
}

/** The on-disk form, so a hand-merged index is byte-identical to one the tracer wrote. */
export function serializeTraceIndex(index: TraceIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

export async function saveTraceIndex(cwd: string, index: TraceIndex): Promise<void> {
  await mkdir(traceDir(cwd), { recursive: true });
  // Atomic: this file is the ONLY record that a trace was written. A torn write during a multi-hour run
  // costs every token that run has spent — the same failure already paid for with board.json and memory.jsonl.
  await writeAtomic(join(traceDir(cwd), TRACE_INDEX), `${JSON.stringify(index, null, 2)}\n`);
}

/** Reads one trace, or undefined when the file has none. */
export async function readTrace(cwd: string, file: string): Promise<string | undefined> {
  try { return await readFile(tracePath(cwd, file), "utf8"); } catch { return undefined; }
}

/** Synchronous read for the tool path, which is called often and must not await on every lookup. */
/** The index, read synchronously — small, and the sync trace reader needs it to follow an adopted doc. */
function indexSync(cwd: string): TraceIndex {
  try {
    const raw = JSON.parse(readFileSync(join(traceDir(cwd), TRACE_INDEX), "utf8")) as TraceIndex;
    if (raw?.version === 1 && typeof raw.traces === "object" && raw.traces !== null) return raw;
  } catch { /* no index yet */ }
  return { version: 1, traces: {} };
}

/**
 * Has the file moved on since its trace was written?
 *
 * The hash has been stored since the first version, with a comment saying the trace is stale when it stops
 * matching — and nothing on the read path ever looked. So after any task edited a file, `graph_trace` went on
 * serving the description of the code as it USED to be, with no mark on it. That is worse than having no
 * trace: an agent reads a confident account of code that no longer exists and trusts it, because a trace is
 * the one source in the project that claims to say why.
 */
function traceIsStale(cwd: string, file: string, rec: TraceRecord | undefined): boolean {
  if (!rec?.hash) return false;
  try { return hashContent(readFileSync(join(stateRoot(cwd), file), "utf8")) !== rec.hash; }
  catch { return false; } // deleted or unreadable — pruning's job, not a staleness claim
}

const STALE_BANNER =
  "> ⚠️ **This file has changed since this note was written.** Treat everything below as the previous "
  + "version: the purpose is probably still right, the specifics may not be. Read the file itself before "
  + "relying on any detail here.\n\n";

export function readTraceSync(cwd: string, file: string): string | undefined {
  const rec = indexSync(cwd).traces[file];
  const mark = (body: string): string => (traceIsStale(cwd, file, rec) ? STALE_BANNER + body : body);
  // An adopted file is described by one of the project's own documents; serve that rather than nothing.
  if (rec?.doc) {
    try { return mark(readFileSync(join(stateRoot(cwd), rec.doc), "utf8")); } catch { /* moved or deleted → fall through */ }
  }
  // The path becomes a filesystem lookup, so it must not be able to leave the trace directory.
  if (!file || file.includes("..") || file.startsWith("/")) return undefined;
  try { return mark(readFileSync(tracePath(cwd, file), "utf8")); } catch { return undefined; }
}

export interface TraceJob {
  file: string;
  hash: string;
  content: string;
  /** How this file sits in the graph — handed to the writer so a trace can state relationships, not guess. */
  symbols: string[];
  usedBy: string[];
  uses: string[];
}

export interface TracePlan {
  /** Files that need a trace written or rewritten. */
  jobs: TraceJob[];
  /** Files whose trace is already current — the saving from hashing rather than rewriting everything. */
  upToDate: number;
  /** Rough input tokens the run will send. */
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  skipped: { file: string; why: string }[];
}

/** Files large enough that tracing them costs more than it returns; the graph still covers their structure. */
export const MAX_TRACE_FILE_CHARS = 60_000;
/**
 * Characters per BILLED token, measured rather than assumed.
 *
 * 4.0 is the usual rule of thumb for English prose and it was wrong here in the expensive direction: measured
 * over 59,158 real calls across every configured model, the median is 3.13, so every estimate was ~28% low.
 * Two reasons, and both belong in a number the user is deciding on: non-English text tokenises worse (this
 * project's code and documents are Turkish), and the gateway prepends a system prompt of its own — measured
 * at ~2,000 tokens per call — which we never sent but are billed for.
 *
 * So this is deliberately not a tokeniser constant. It predicts the BILL, which is the only thing the person
 * reading the estimate is being asked about.
 */
const CHARS_PER_TOKEN = 3.13;
/** What one trace is asked to be. Used for the estimate and enforced by the prompt. */
export const TRACE_OUTPUT_TOKENS = 350;

/** Where one file stands against the index. `missing` and `stale` are the two that cost a model call. */
export type TraceState = "current" | "missing" | "stale" | "too-large" | "empty";

/**
 * Whether a file is covered, and if not, why not.
 *
 * Extracted so the coverage the start-up summary reports and the work `/graph trace` queues are decided by
 * ONE rule. Two implementations of "is this traced?" drift, and the failure is silent in the worst
 * direction: a summary that reads as complete beside a plan with 226 jobs in it.
 *
 * The entry has to still be BACKED by something on disk — an index that outlived its files would keep a
 * project permanently untraced. What backs it depends on the kind: a trace we wrote is the `.md` under the
 * trace root, while an ADOPTED entry points at one of the project's own documents, which is the only copy
 * by design. Checking only for the `.md` meant every adopted entry failed and was queued — measured on a
 * real project, 414 of 424 adopted files, which is precisely the re-derivation adoption exists to avoid.
 */
export function traceState(
  cwd: string, file: string, content: string, index: TraceIndex, hash = hashContent(content),
): TraceState {
  if (content.length > MAX_TRACE_FILE_CHARS) return "too-large";
  if (!content.trim()) return "empty";
  const rec = index.traces[file];
  const backing = rec?.doc ? join(cwd, rec.doc) : tracePath(cwd, file);
  if (!rec || !existsSync(backing)) return "missing";
  // A changed hash is the drift signal, and it is wanted: the trace describes code that has moved on.
  return rec.hash === hash ? "current" : "stale";
}

/** How much of a project is covered — the denominator the trace count never had. */
export interface TraceCoverage {
  /** Files a trace run would consider at all (large and empty ones excluded — they are never work). */
  traceable: number;
  current: number;
  /** Never traced. */
  missing: number;
  /** Traced, then the source changed. */
  stale: number;
}

/**
 * Counts coverage without building a plan.
 *
 * Reads and hashes every traceable file and keeps none of it, so a project's size costs time and not memory
 * — measured on the largest project to hand, 2,524 files in 313 ms. `planTraces` holds the content of every
 * QUEUED file so it can send it, which is the right trade for a run about to spend tokens and the wrong one
 * for a line on the start-up screen.
 */
export async function traceCoverage(cwd: string, files: string[], index: TraceIndex): Promise<TraceCoverage> {
  const out: TraceCoverage = { traceable: 0, current: 0, missing: 0, stale: 0 };
  for (const file of files) {
    let content: string;
    try { content = await readFile(join(cwd, file), "utf8"); } catch { continue; }
    const state = traceState(cwd, file, content, index);
    if (state === "too-large" || state === "empty") continue;
    out.traceable++;
    out[state]++;
  }
  return out;
}

/**
 * Works out what tracing would involve, WITHOUT spending anything.
 *
 * Everything the consent prompt shows comes from here, so it must be honest: the file count, the token
 * estimate, and what is being skipped and why.
 */
export async function planTraces(
  cwd: string,
  files: string[],
  graph: ProjectGraph | undefined,
  index: TraceIndex,
): Promise<TracePlan> {
  const jobs: TraceJob[] = [];
  const skipped: { file: string; why: string }[] = [];
  let upToDate = 0;

  // Which symbols each file defines, and how files relate — derived once rather than per file.
  const symbolsOf = new Map<string, string[]>();
  const fileOfNode = new Map<string, string>();
  if (graph) {
    for (const n of graph.nodes) {
      if (!n.source_file) continue;
      fileOfNode.set(n.id, n.source_file);
      const list = symbolsOf.get(n.source_file);
      if (list) list.push(n.label); else symbolsOf.set(n.source_file, [n.label]);
    }
  }
  /**
   * File-to-file adjacency, built in ONE pass over the edges.
   *
   * This used to re-scan every edge for every file, which is quadratic and reads as instant on a small
   * project. Measured on a real one — 55,081 nodes, 78,540 edges, 4,664 traceable files — that is 366 million
   * iterations, and planning (which happens BEFORE the user is asked anything, and spends no tokens) took
   * minutes with nothing on screen. One pass makes it a lookup.
   */
  const usedByOf = new Map<string, Set<string>>();
  const usesOf = new Map<string, Set<string>>();
  if (graph) {
    for (const e of graph.edges) {
      const sf = fileOfNode.get(e.source);
      const tf = fileOfNode.get(e.target);
      if (!sf || !tf || sf === tf) continue;
      let a = usedByOf.get(tf); if (!a) { a = new Set(); usedByOf.set(tf, a); } a.add(sf);
      let b = usesOf.get(sf); if (!b) { b = new Set(); usesOf.set(sf, b); } b.add(tf);
    }
  }
  const relatedOf = (file: string): { usedBy: string[]; uses: string[] } => ({
    usedBy: [...(usedByOf.get(file) ?? [])].slice(0, 12),
    uses: [...(usesOf.get(file) ?? [])].slice(0, 12),
  });

  for (const file of files) {
    let content: string;
    try { content = await readFile(join(cwd, file), "utf8"); } catch { continue; }
    const hash = hashContent(content);
    const state = traceState(cwd, file, content, index, hash);
    if (state === "too-large") {
      skipped.push({ file, why: `${Math.round(content.length / 1000)} KB — too large to trace economically` });
      continue;
    }
    if (state === "empty") continue;
    if (state === "current") { upToDate++; continue; }
    const rel = relatedOf(file);
    jobs.push({ file, hash, content, symbols: (symbolsOf.get(file) ?? []).slice(0, 40), ...rel });
  }

  const estimatedInputTokens = Math.round(jobs.reduce((n, j) => n + j.content.length / CHARS_PER_TOKEN, 0) + jobs.length * 200);
  return { jobs, upToDate, estimatedInputTokens, estimatedOutputTokens: jobs.length * TRACE_OUTPUT_TOKENS, skipped };
}

/** The instruction one tracer follows. Kept here so the estimate and the request cannot drift apart. */
export function tracePrompt(job: TraceJob, brief?: string): string {
  const rel = [
    job.symbols.length ? `Defines: ${job.symbols.join(", ")}` : "",
    job.usedBy.length ? `Used by: ${job.usedBy.join(", ")}` : "Used by: nothing else in this repo",
    job.uses.length ? `Uses: ${job.uses.join(", ")}` : "",
  ].filter(Boolean).join("\n");
  // The brief is what lets a trace say what a file is FOR rather than what it does. Without it every tracer
  // would either re-read the project's documentation itself or guess — the first expensive, the second worse.
  const context = brief
    ? `What this project IS, from its own documentation — use this vocabulary and these rules; do not ` +
      `contradict them and do not repeat them back:\n${brief}\n\n---\n\n`
    : "";
  return `${context}Write a short reference note about ONE source file, for an engineer who has never seen this codebase ` +
    `and is about to change it.\n\n` +
    `Answer, in at most 150 words total, under these exact headings:\n` +
    `**Purpose** — what this file is responsible for, in one or two sentences. Say what it is FOR in the ` +
    `product's terms, not what its syntax does. "Decides which model a role gets when its first choice is ` +
    `rate-limited" is useful; "exports a function that returns an array" is not.\n` +
    `**Key decisions** — any non-obvious choice a reader would otherwise undo by accident. Omit the heading ` +
    `entirely if there are none; do not invent one.\n` +
    `**Careful** — what breaks elsewhere if this changes, based on the relationships given below. Omit if ` +
    `nothing does.\n\n` +
    `Rules:\n` +
    `- State only what the code and the relationships below actually show. If the business purpose is not ` +
    `evident, say what the file does technically and do NOT speculate about why.\n` +
    `- No preamble, no restating the filename, no summary of what you were asked.\n\n` +
    `File: ${job.file}\n${rel}\n\n---\n${job.content}`;
}

/** Writes one trace to disk and returns the record for the index. */
export async function saveTrace(cwd: string, job: TraceJob, body: string, model?: string): Promise<TraceRecord> {
  const path = tracePath(cwd, job.file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `# ${job.file}\n\n${body.trim()}\n`, "utf8");
  return { hash: job.hash, file: job.file, writtenAt: Date.now(), ...(model ? { model } : {}) };
}

/** Drops traces for files that no longer exist, so the directory cannot fill with descriptions of nothing. */
export async function pruneTraces(cwd: string, liveFiles: Set<string>, index: TraceIndex): Promise<string[]> {
  const gone = Object.keys(index.traces).filter((f) => !liveFiles.has(f));
  for (const f of gone) {
    delete index.traces[f];
    await rm(tracePath(cwd, f), { force: true });
  }
  return gone;
}

/**
 * The gitignore rules that put project knowledge in the repo and machine-local state out of it.
 *
 * horse-code writes these itself, because getting them wrong is silent and costly in both directions: traces
 * that are ignored are re-bought by every clone, and an AST cache that is committed is a guaranteed merge
 * conflict keyed by another machine's mtimes. A user should not have to know that `.horsecode/` is usually
 * ignored wholesale, nor that gitignore has no trailing comments.
 */
export const GITIGNORE_MARKER = "# horse-code project knowledge";
/**
 * Built on demand, not at import: `setTraceRoot` runs after this module loads, and a block frozen at import
 * time would name the default root while traces went somewhere else — a rule that silently protects nothing.
 */
/**
 * Project knowledge belongs in the repository; only derived artefacts stay out.
 *
 * The traces and the code graph are what let a fresh clone understand the project without rebuilding that
 * understanding — the graph costs minutes of parsing, the traces cost millions of tokens. Both are therefore
 * COMMITTED, and this file's job is to make sure nothing quietly excludes them.
 *
 * Measured on a real project: its `.gitignore` blocked `graphify-out/` wholesale, under a rationale calling
 * the directory local-only. That decision predates the graph being shared knowledge, and it silently kept
 * every clone paying to rebuild it.
 */
const SHARED_DERIVED: { path: string; why: string }[] = [
  /**
   * The community names, and NOT the graph they name.
   *
   * The graph used to be here too, and it is the one thing in this list that cannot survive a merge. It is a
   * single line of JSON — 33.7 MB of it on a real project — and git merges by line, so two branches that
   * both rebuilt it have nothing to reconcile. Measured on PR 677: of twelve files touched by the merge,
   * every one auto-merged except `graphify-out/graph.json` and the labels beside it, and those two blocked
   * the pull request outright. Rebuilding it costs CPU and nothing else, `graphify update` is incremental,
   * and a session gets its copy through INHERITED_ASSETS without git being involved at all.
   *
   * The names are the opposite on every count. graphify's clustering finds the communities on its own, but
   * naming them is step 5 of its runbook and the step an LLM performs: "look at its node labels and write a
   * 2-5 word plain-language name". `graph.json` stores each node's community NUMBER and nothing else —
   * measured on a real project, not one of its 6,283 names appears anywhere in the graph file. So a clone
   * that has the graph still reads "community 47" where this file says "Wallet Member & Balance", and
   * getting that back means paying an LLM for the naming pass again.
   *
   * It merges, too: `pruneAreaNames` writes one key per line in numeric order precisely so that a change to
   * one name is a change to one line. Two branches adding different names merge cleanly; only two branches
   * naming the SAME community differently conflict, in 136 KB rather than 33.7 MB.
   */
  { path: "graphify-out/.graphify_labels.json", why: "# Shared — the community names an LLM wrote; the graph stores only their numbers." },
];

/**
 * The derived files that ship WITH the work, for the code that has to commit them.
 *
 * Read from the same list the `.gitignore` rules come from on purpose: a path un-ignored but never committed,
 * or committed but still ignored, is the kind of split that survives a test suite and fails in a real run.
 */
/** The derived files that stay in this checkout — named here so tests and rules cannot drift apart. */
export function localOnly(): string[] {
  return [...LOCAL_ONLY];
}

export function sharedDerived(): string[] {
  return SHARED_DERIVED.map((s) => s.path);
}

/** Regenerated on every build, or keyed to one machine's paths — these genuinely do not belong in git. */
const LOCAL_ONLY = [
  "graphify-out/manifest.json", "graphify-out/graph.html", "graphify-out/.graphify_root",
  // The graph itself: rebuilt per checkout, inherited by copy, and unmergeable by construction — see above.
  "graphify-out/graph.json",
  // …and the commit it was built at, which describes that local copy and travels with it.
  "graphify-out/.graph-commit.json",
];

/**
 * Nested checkouts, which must never reach a remote whoever created them.
 *
 * horse-code keeps its own out through `.horsecode/.gitignore`, and then a real project showed the other
 * half of the problem: `git status` listed three untracked `.claude/worktrees/…` directories — another
 * tool's working copies, each a full checkout of the same repository. Committing one is committing the
 * repository into itself; the same directory's abandoned sibling was 29 GB.
 *
 * Added only when the directory actually exists. A rule for a tool the project does not use is noise in a
 * file everyone reads.
 */
const NESTED_CHECKOUTS = [".claude/worktrees/", ".horsecode/worktrees/"];

/**
 * Git will not descend into an excluded DIRECTORY, so `dir/` cannot be negated for anything inside it.
 * Rewriting the blanket rule to `dir/*` keeps the same exclusion while making a negation possible.
 */
function openDirectory(text: string, dir: string): string {
  return text.split("\n").map((l) => (l.trim() === `${dir}/` ? l.replace(`${dir}/`, `${dir}/*`) : l)).join("\n");
}

interface Plan { text: string; rules: string[] }

/** What this repository is missing, and the edits needed to make the missing rules possible. */
function planGitignore(current: string, root0 = "."): Plan {
  let text = current;
  const rules: string[] = [];
  const lines = (): string[] => text.split("\n").map((l) => l.trim());
  const has = (rule: string): boolean => lines().includes(rule);

  /**
   * Ensures `path` can be committed, opening whatever directory rule stands in its way.
   *
   * `isDir` decides the trailing slash: `!dir/` is the idiom that re-includes a directory, and writing it
   * without one would also match a FILE of that name — a rule that says more than it means.
   */
  const keep = (path: string, isDir: boolean, why: string): void => {
    const dir = path.split("/")[0]!;
    const target = isDir ? `${path}/` : path;
    const blocked = lines().some((l) => l === `${dir}/` || l === `${dir}/*` || l === dir || l === path);
    if (!blocked || has(`!${target}`)) return;
    text = openDirectory(text, dir);
    rules.push(why, `!${target}`);
  };

  keep(traceRootRel().replace(/\\/g, "/"), true,
    "# Shared — the traces describe the code, so every clone starts understanding the project instead of re-buying it.");
  for (const s of SHARED_DERIVED) keep(s.path, false, s.why);

  /**
   * The heading for a group of rules, written once per block.
   *
   * Deliberately NOT skipped when the file already has the same sentence somewhere else. Additions can now
   * arrive on a later run than the block they belong to, and a rule appended under whatever heading happened
   * to be written last reads as belonging to it — measured here, `.horsecode/worktrees/` landed under
   * "the community names an LLM wrote". A sentence repeated once is cheaper for a reader than a rule filed
   * under the wrong reason.
   */
  const note = (comment: string): void => { if (!rules.includes(comment)) rules.push(comment); };

  const nested = NESTED_CHECKOUTS.filter((d) => existsSync(join(root0, d)) && !has(d) && !has(d.replace(/\/$/, "")));
  if (nested.length) {
    note("# Nested checkouts of this repository — committing one commits the repository into itself.");
    rules.push(...nested);
  }

  const local = LOCAL_ONLY.filter((r) => !has(r) && !has("graphify-out/") && !has("graphify-out/*"));
  if (local.length) {
    note("# Machine-local or derived: an AST cache keyed by local mtimes, and a viewer regenerated on every build.");
    rules.push(...local);
  }
  return { text, rules };
}

/**
 * Adds whatever rules this repository is still missing.
 *
 * The marker used to end the work before it started — `if (current.includes(MARKER)) return false` ran ahead
 * of planning, so a project that had been through this once could never receive a rule added later. Measured
 * on a real project: its `.gitignore` already carried the marker, and the rule for the community names could
 * not reach it at all.
 *
 * The marker was never what made repeat calls safe. `planGitignore` is idempotent by construction — `keep()`
 * skips a negation the file already has — so the marker only decided where a NEW block goes, and a file that
 * has one gets its additions appended under it rather than a second copy of the heading.
 */
export async function ensureGitignore(cwd: string): Promise<boolean> {
  const path = join(cwd, ".gitignore");
  let current = "";
  try { current = await readFile(path, "utf8"); } catch { /* no .gitignore yet → create one */ }

  const plan = planGitignore(current, cwd);
  if (!plan.rules.length && plan.text === current) return false; // already says everything needed
  const heading = plan.text.includes(GITIGNORE_MARKER) ? "" : `${GITIGNORE_MARKER}\n`;
  const block = plan.rules.length ? `${heading}${plan.rules.join("\n")}\n` : "";
  const body = `${plan.text.trimEnd()}${plan.text.trim() && block ? "\n\n" : ""}${block}`;
  await writeFile(path, body, "utf8");
  return true;
}
