import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { stateRoot } from "./session-scope.js";
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
  await writeFile(join(traceDir(cwd), TRACE_INDEX), `${JSON.stringify(index, null, 2)}\n`, "utf8");
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

export function readTraceSync(cwd: string, file: string): string | undefined {
  // An adopted file is described by one of the project's own documents; serve that rather than nothing.
  const rec = indexSync(cwd).traces[file];
  if (rec?.doc) {
    try { return readFileSync(join(stateRoot(cwd), rec.doc), "utf8"); } catch { /* moved or deleted → fall through */ }
  }
  // The path becomes a filesystem lookup, so it must not be able to leave the trace directory.
  if (!file || file.includes("..") || file.startsWith("/")) return undefined;
  try { return readFileSync(tracePath(cwd, file), "utf8"); } catch { return undefined; }
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
  const relatedOf = (file: string): { usedBy: string[]; uses: string[] } => {
    const usedBy = new Set<string>();
    const uses = new Set<string>();
    if (!graph) return { usedBy: [], uses: [] };
    for (const e of graph.edges) {
      const sf = fileOfNode.get(e.source);
      const tf = fileOfNode.get(e.target);
      if (!sf || !tf || sf === tf) continue;
      if (tf === file) usedBy.add(sf);
      if (sf === file) uses.add(tf);
    }
    return { usedBy: [...usedBy].slice(0, 12), uses: [...uses].slice(0, 12) };
  };

  for (const file of files) {
    let content: string;
    try { content = await readFile(join(cwd, file), "utf8"); } catch { continue; }
    if (content.length > MAX_TRACE_FILE_CHARS) {
      skipped.push({ file, why: `${Math.round(content.length / 1000)} KB — too large to trace economically` });
      continue;
    }
    if (!content.trim()) continue;
    const hash = hashContent(content);
    if (index.traces[file]?.hash === hash && existsSync(tracePath(cwd, file))) { upToDate++; continue; }
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
