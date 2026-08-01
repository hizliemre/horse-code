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
export const TRACE_INDEX = "index.json";

/** Extensions worth a trace — source code, not data or markup. */
const TRACEABLE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|h|cc|cpp|hpp|cs|php|swift|kt|scala)$/;

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
/** Roughly 4 characters per token — good enough for a cost estimate the user is deciding on. */
const CHARS_PER_TOKEN = 4;
/** What one trace is asked to be. Used for the estimate and enforced by the prompt. */
export const TRACE_OUTPUT_TOKENS = 350;

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
    if (content.length > MAX_TRACE_FILE_CHARS) {
      skipped.push({ file, why: `${Math.round(content.length / 1000)} KB — too large to trace economically` });
      continue;
    }
    if (!content.trim()) continue;
    const hash = hashContent(content);
    /**
     * Already covered?
     *
     * The entry has to still be BACKED by something on disk — an index that outlived its files would keep a
     * project permanently untraced. What backs it depends on the kind: a trace we wrote is the `.md` beside
     * the source, while an ADOPTED entry points at one of the project's own documents, which is the only
     * copy by design.
     *
     * Checking only for the `.md` meant every adopted entry failed and was queued for tracing — measured on
     * a real project, 414 of 424 adopted files, which is precisely the re-derivation adoption exists to
     * avoid. A changed hash still queues the file either way: that is the drift signal, and it is wanted.
     */
    const rec = index.traces[file];
    const backing = rec?.doc ? join(cwd, rec.doc) : tracePath(cwd, file);
    if (rec?.hash === hash && existsSync(backing)) { upToDate++; continue; }
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
const gitignoreBlock = (): string => `${GITIGNORE_MARKER}
# Shared — it describes the code, so every clone starts understanding the project instead of rebuilding it.
!${traceRootRel().replace(/\\/g, "/")}/
# Machine-local or derived: an AST cache keyed by local mtimes, and a viewer regenerated on every build.
graphify-out/manifest.json
graphify-out/graph.html
graphify-out/.graphify_root
`;
/**
 * Ensures the repo's .gitignore carries those rules. Returns true when it wrote them.
 *
 * Appends only, and only once — an existing .gitignore is never rewritten or reordered. If the marker is
 * already present the file is left completely alone, so a user who edited the rules keeps their edits.
 */
export async function ensureGitignore(cwd: string): Promise<boolean> {
  const path = join(cwd, ".gitignore");
  let current = "";
  try { current = await readFile(path, "utf8"); } catch { /* no .gitignore yet → create one */ }
  if (current.includes(GITIGNORE_MARKER)) return false;
  // `.horsecode/*` (not `.horsecode/`) is what makes the traces re-includable: git will not descend into an
  // excluded DIRECTORY, so a blanket `.horsecode/` cannot be negated for a subdirectory.
  const fixed = current.replace(/^\.horsecode\/\s*$/m, ".horsecode/*");
  const body = `${fixed.trimEnd()}${fixed.trim() ? "\n\n" : ""}${gitignoreBlock()}`;
  await writeFile(path, body, "utf8");
  return true;
}
