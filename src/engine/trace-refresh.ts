import type { Provider } from "../core/types.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { traceable, loadTraceIndex, saveTraceIndex, pruneTraces } from "./trace.js";
import { planFor, runTraces } from "./trace-run.js";
import { buildProjectGraph } from "./project-graph.js";
import type { GitRunner } from "../worktree/git.js";

/**
 * Keeping the project's account of itself true after the project changes.
 *
 * Traces were only ever written by `/graph trace`, a user action over the whole repository. Nothing in the
 * coding pipeline touched them, which left two holes that widened with every task: a file a task CREATED had
 * no trace at all, and a file a task CHANGED kept the trace describing the version before the change.
 *
 * The second is the dangerous one. A trace is the one artefact in the project that claims to say WHY, so an
 * agent reads it and believes it — and an out-of-date trace is a confident, specific, wrong answer. The read
 * path now marks staleness (see `readTraceSync`), which stops the lie; this closes the gap that produced it.
 *
 * Cost, measured on a real run: ~1.07k input + ~350 output tokens per file. A task touching ten files pays
 * about 14k — invisible next to the task that wrote them.
 */

/** Files whose diff cannot change what a trace would say. */
const IRRELEVANT = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;

export interface RefreshResult {
  traced: number;
  failed: number;
  /** Traces removed because the task deleted the file they described. */
  removed: number;
  /** Files that were changed but needed no new trace — unchanged content, or not a trace subject. */
  skipped: number;
  graph?: string;
}

/**
 * Which files a merge brought into the base.
 *
 * Taken from git rather than from what the implementer reported writing: the merge is the thing that decided
 * what actually landed, and a task that wrote a file and then reverted it must not be traced for it.
 */
export async function changedByMerge(
  git: GitRunner, cwd: string, before: string, after = "HEAD",
): Promise<string[]> {
  if (!before) return [];
  const r = await git(["diff", "--name-only", `${before}..${after}`], cwd);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l && !IRRELEVANT.test(l));
}

/**
 * Re-derives the traces for a set of changed files, in the worktree that owns the state.
 *
 * Never throws. A task's work is already merged by the time this runs, and failing the task because its
 * documentation could not be refreshed would throw away the thing of value to protect the thing describing
 * it. Every failure is reported and swallowed.
 */
export async function refreshTraces(opts: {
  cwd: string;
  files: string[];
  provider: Provider;
  /** The tracer's chain; the first entry that answers wins, as everywhere else. */
  models: string[];
  signal?: AbortSignal;
  note?: (text: string) => void;
}): Promise<RefreshResult> {
  const out: RefreshResult = { traced: 0, failed: 0, removed: 0, skipped: 0 };
  const candidates = traceable(opts.files);
  out.skipped = opts.files.length - candidates.length;

  /**
   * A file the task DELETED still has a trace, and nothing else will ever remove it.
   *
   * Whole-repository runs prune by handing the runner every file that should still exist. A partial run
   * cannot do that — its list is one task's worth of changes, and the pruner would read every other trace as
   * orphaned — so deletions are handled here, by name, from the same diff that named the additions. Without
   * this, `graph_trace` keeps answering for files that are gone: the read path deliberately does not call
   * THAT stale, because a missing file is a deletion to be tidied, not a description to distrust.
   */
  const gone = candidates.filter((f) => !existsSync(join(opts.cwd, f)));
  if (gone.length) {
    try {
      const index = await loadTraceIndex(opts.cwd);
      const kept = new Set(Object.keys(index.traces).filter((f) => !gone.includes(f)));
      out.removed = (await pruneTraces(opts.cwd, kept, index)).length;
      if (out.removed) await saveTraceIndex(opts.cwd, index);
    } catch { /* a trace left behind is untidy; failing the task over it is worse */ }
  }

  const targets = candidates.filter((f) => !gone.includes(f));
  if (!targets.length) return out;

  const model = opts.models.find(Boolean);
  if (!model) return out;

  try {
    // First, so a file that did not exist a minute ago has symbols and relationships to be described BY.
    // Incremental and pure AST — the rebuild re-parses only what changed, and costs no tokens.
    const g = await buildProjectGraph(opts.cwd);
    out.graph = g.message;

    const plan = await planFor(opts.cwd, targets);
    // An unchanged file is already up to date and produces no job; this is how a task that touched ten files
    // but only really changed two ends up paying for two.
    if (!plan.jobs.length) { out.skipped += targets.length; return out; }

    const res = await runTraces({
      cwd: opts.cwd,
      provider: opts.provider,
      model,
      plan,
      // No liveFiles: this run knows only the files one task changed, and a pruner given that list would
      // read every OTHER trace in the project as orphaned and delete it.
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    out.traced = res.written;
    out.failed = res.failed.length;
    out.skipped += res.upToDate;
  } catch (e) {
    opts.note?.(`Trace refresh failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}

/** One line for the run log, or nothing when there was nothing to say. */
export function describeRefresh(r: RefreshResult): string | undefined {
  if (!r.traced && !r.failed && !r.removed) return undefined;
  const bits = [`📝 ${r.traced} trace(s) refreshed`];
  if (r.removed) bits.push(`${r.removed} removed for deleted file(s)`);
  if (r.failed) bits.push(`${r.failed} failed`);
  return `${bits.join(" · ")} — the changed files now describe themselves.`;
}


/**
 * Commits what a refresh wrote, immediately.
 *
 * Leaving the new traces uncommitted in the base worktree broke the NEXT merge: git refuses to merge a
 * branch that would overwrite a modified working file, and a trace lives at the same path a documentation
 * task edits. Measured on a real run — `error: Your local changes to the following files would be
 * overwritten by merge: docs/architecture/…/safe-html.pipe.ts.md` — the run died there, with eleven tasks
 * already merged.
 *
 * They belong in the commit anyway. The whole point of writing them into the session is that they ship with
 * the work; leaving them loose in the working tree was never the intent, only the omission.
 */
export async function commitRefreshed(
  git: GitRunner, baseWorktree: string, traceRootRel: string,
): Promise<boolean> {
  const add = await git(["add", "--", traceRootRel], baseWorktree);
  if (add.code !== 0) return false;
  const staged = await git(["diff", "--cached", "--quiet", "--", traceRootRel], baseWorktree);
  if (staged.code === 0) return false; // nothing actually changed
  const r = await git(["commit", "-m", "docs(traces): refresh for the files this task changed", "--", traceRootRel], baseWorktree);
  return r.code === 0;
}
