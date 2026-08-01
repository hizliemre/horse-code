import type { Provider } from "../core/types.js";
import { traceable } from "./trace.js";
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
  const out: RefreshResult = { traced: 0, failed: 0, skipped: 0 };
  const targets = traceable(opts.files);
  out.skipped = opts.files.length - targets.length;
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
  if (!r.traced && !r.failed) return undefined;
  const bits = [`📝 ${r.traced} trace(s) refreshed`];
  if (r.failed) bits.push(`${r.failed} failed`);
  return `${bits.join(" · ")} — the changed files now describe themselves.`;
}
