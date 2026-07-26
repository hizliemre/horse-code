import type { ChatRequest, Provider } from "../core/types.js";
import {
  planTraces, tracePrompt, saveTrace, pruneTraces, loadTraceIndex, saveTraceIndex, ensureGitignore,
} from "./trace.js";
import type { TraceJob, TracePlan } from "./trace.js";
import { loadGraph } from "./project-graph.js";

/** How many tracers run at once. Enough to finish a repo quickly, few enough not to trip provider rate limits. */
export const TRACE_CONCURRENCY = 6;

export interface TraceRunResult {
  written: number;
  failed: { file: string; error: string }[];
  pruned: string[];
  upToDate: number;
  cancelled: boolean;
  /** True when the .gitignore rules keeping traces in and the AST cache out were just added. */
  wroteGitignore?: boolean;
}

/** Renders the estimate a user is asked to approve. Deliberately blunt about what it will cost. */
export function describePlan(plan: TracePlan, model: string): string {
  if (!plan.jobs.length) {
    return plan.upToDate
      ? `All ${plan.upToDate} traces are current — nothing to write, nothing to spend.`
      : "No files to trace.";
  }
  const kIn = Math.round(plan.estimatedInputTokens / 1000);
  const kOut = Math.round(plan.estimatedOutputTokens / 1000);
  const skipped = plan.skipped.length
    ? `\n\nSkipped as too large to trace economically: ${plan.skipped.map((s) => `\`${s.file}\``).join(", ")}`
    : "";
  const cached = plan.upToDate ? `\n${plan.upToDate} file(s) already have a current trace and will be left alone.` : "";
  return `**Tracing ${plan.jobs.length} file(s)** with \`${model}\`.\n\n` +
    `This is the part of understanding your project that costs tokens — the graph was free, this is not. ` +
    `Each file is read once and described in ~150 words.\n\n` +
    `Rough cost: **~${kIn}k input + ~${kOut}k output tokens**.${cached}${skipped}`;
}

/** Runs one tracer. Returns the written body, or throws with a reason the caller reports. */
async function traceOne(provider: Provider, model: string, job: TraceJob, signal: AbortSignal): Promise<string> {
  const req: ChatRequest = {
    model,
    messages: [
      { role: "system", content: "You write terse, factual reference notes about source files. You never speculate." },
      { role: "user", content: tracePrompt(job) },
    ],
    tools: [],
  };
  let out = "";
  for await (const ev of provider.chat(req, signal)) {
    if (ev.type === "text-delta") out += ev.text;
    else if (ev.type === "error") throw new Error(ev.message);
  }
  const body = out.replace(/<\/?think>/gi, "").trim();
  if (!body) throw new Error("empty response");
  return body;
}

/**
 * Writes the traces in a plan.
 *
 * Each file is independent, so one failure never stops the rest — a trace that could not be written is
 * reported and the file simply stays untraced, which is the state it was already in. The index is saved at
 * the end so an interrupted run keeps whatever it managed to write.
 */
export async function runTraces(opts: {
  cwd: string;
  provider: Provider;
  model: string;
  plan: TracePlan;
  liveFiles: Set<string>;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, file: string) => void;
}): Promise<TraceRunResult> {
  const { cwd, plan } = opts;
  const signal = opts.signal ?? new AbortController().signal;
  const index = await loadTraceIndex(cwd);
  const failed: { file: string; error: string }[] = [];
  let written = 0;
  let done = 0;

  const queue = [...plan.jobs];
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = queue.shift();
      if (!job || signal.aborted) return;
      try {
        const body = await traceOne(opts.provider, opts.model, job, signal);
        index.traces[job.file] = await saveTrace(cwd, job, body, opts.model);
        written++;
      } catch (e) {
        if (signal.aborted) return;
        failed.push({ file: job.file, error: e instanceof Error ? e.message : String(e) });
      }
      opts.onProgress?.(++done, plan.jobs.length, job.file);
    }
  };
  await Promise.all(Array.from({ length: Math.min(TRACE_CONCURRENCY, queue.length) }, worker));

  const pruned = await pruneTraces(cwd, opts.liveFiles, index);
  await saveTraceIndex(cwd, index);
  // Written now rather than up front: only a run that actually produced something needs the rules.
  const wroteGitignore = written > 0 && await ensureGitignore(cwd);
  return { written, failed, pruned, upToDate: plan.upToDate, cancelled: signal.aborted, wroteGitignore };
}

/** Builds the plan for a working directory — the step that runs before asking the user anything. */
export async function planFor(cwd: string, files: string[]): Promise<TracePlan> {
  return planTraces(cwd, files, await loadGraph(cwd), await loadTraceIndex(cwd));
}
