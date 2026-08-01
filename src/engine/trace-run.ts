import type { ChatRequest, Provider } from "../core/types.js";
import {
  planTraces, tracePrompt, saveTrace, pruneTraces, loadTraceIndex, saveTraceIndex, ensureGitignore, traceRootRel,
} from "./trace.js";
import type { TraceJob, TracePlan } from "./trace.js";
import { loadGraph } from "./project-graph.js";
import { briefForPrompt, gatherBriefInput, briefPrompt, saveBrief, briefStatus } from "./project-brief.js";

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

/**
 * How often the index is written mid-run.
 *
 * Small enough that an interrupted run loses seconds of work, large enough that the write is not the thing
 * the run is doing. Every trace already exists on disk by then; this only records that it does.
 */
const INDEX_CHECKPOINT = 25;

/** Renders the estimate a user is asked to approve. Deliberately blunt about what it will cost. */
export function describePlan(plan: TracePlan, model: string): string {
  if (!plan.jobs.length) {
    return plan.upToDate
      ? `All ${plan.upToDate} traces are current — nothing to write, nothing to spend.`
      : "No files to trace.";
  }
  const kIn = Math.round(plan.estimatedInputTokens / 1000);
  const kOut = Math.round(plan.estimatedOutputTokens / 1000);
  /**
   * The skipped list, COUNTED rather than printed.
   *
   * It used to name every file. On a real project that was 110 EF Core migration paths filling the entire
   * screen above the question the user was being asked — the same failure as the launch banner that printed
   * every rule: complete, and therefore unread. A count and a few examples say the same thing and leave the
   * question visible.
   */
  const skipped = plan.skipped.length
    ? `\n\n${plan.skipped.length} file(s) skipped as too large to trace economically`
      + ` (e.g. ${plan.skipped.slice(0, 3).map((s) => `\`${s.file}\``).join(", ")}${plan.skipped.length > 3 ? ", …" : ""}).`
    : "";
  const cached = plan.upToDate ? `\n${plan.upToDate} file(s) already have a current trace and will be left alone.` : "";
  return `**Tracing ${plan.jobs.length} file(s)** with \`${model}\`.\n\n` +
    `This is the part of understanding your project that costs tokens — the graph was free, this is not. ` +
    `Each file is read once and described in ~150 words.\n\n` +
    `Rough cost: **~${kIn}k input + ~${kOut}k output tokens**.${cached}${skipped}`;
}

/** Runs one tracer. Returns the written body, or throws with a reason the caller reports. */
async function traceOne(provider: Provider, model: string, job: TraceJob, signal: AbortSignal, brief?: string): Promise<string> {
  const req: ChatRequest = {
    model,
    messages: [
      { role: "system", content: "You write terse, factual reference notes about source files. You never speculate." },
      { role: "user", content: tracePrompt(job, brief) },
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
  /**
   * Reports EVERY file as it finishes, with what happened to it.
   *
   * It used to report a bare count, which the caller then throttled to one line per few hundred files: for a
   * 2,447-file run that is a screen that barely moves for hours, and no way to tell a working run from a
   * stuck one. What a person watching wants is the same thing a file-writing tool shows them — which file,
   * where it went, how much was written.
   */
  onProgress?: (ev: { done: number; total: number; file: string; wroteTo?: string; words?: number; error?: string }) => void;
}): Promise<TraceRunResult> {
  const { cwd, plan } = opts;
  const signal = opts.signal ?? new AbortController().signal;
  const index = await loadTraceIndex(cwd);
  const brief = briefForPrompt(cwd); // read once, not per file
  const failed: { file: string; error: string }[] = [];
  let written = 0;
  let done = 0;

  const queue = [...plan.jobs];
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = queue.shift();
      if (!job || signal.aborted) return;
      let wroteTo: string | undefined;
      let words: number | undefined;
      let error: string | undefined;
      try {
        const body = await traceOne(opts.provider, opts.model, job, signal, brief);
        const rec = await saveTrace(cwd, job, body, opts.model);
        index.traces[job.file] = rec;
        wroteTo = `${traceRootRel()}/${job.file}.md`;
        words = body.split(/\s+/).filter(Boolean).length;
        written++;
        // Checkpointed, not deferred to the end: this index is the only record that the tokens already spent
        // bought anything, and a run this long WILL be interrupted.
        if (written % INDEX_CHECKPOINT === 0) await saveTraceIndex(cwd, index);
      } catch (e) {
        if (signal.aborted) return;
        error = e instanceof Error ? e.message : String(e);
        failed.push({ file: job.file, error });
      }
      opts.onProgress?.({
        done: ++done, total: plan.jobs.length, file: job.file,
        ...(wroteTo !== undefined && { wroteTo }), ...(words !== undefined && { words }),
        ...(error !== undefined && { error }),
      });
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

/**
 * Builds the project brief — the one call that establishes what the product is, before any file is traced.
 *
 * Runs first and separately because everything after it depends on it: a trace written without the brief
 * describes mechanics, and rewriting all of them later costs the whole run again.
 */
export async function buildBrief(opts: {
  cwd: string;
  provider: Provider;
  model: string;
  files: string[];
  signal?: AbortSignal;
  /** Rewrite even when the documents have not changed. */
  force?: boolean;
}): Promise<{ ok: boolean; message: string; skipped?: boolean }> {
  // Re-deriving an unchanged brief spends the same tokens for the same paragraphs. Tracing runs often; this
  // has to be paid once per change to the documentation, not once per run.
  if (!opts.force) {
    const st = await briefStatus(opts.cwd, opts.files);
    if (st.built && !st.stale) {
      return { ok: true, skipped: true, message: `Project brief is current (${st.sources.length} document(s)) — not rewritten.` };
    }
  }
  const input = await gatherBriefInput(opts.cwd, opts.files);
  if (!input) {
    return { ok: false, message: "No documentation found (README, docs/, specs/) — traces will describe the code without product context." };
  }
  const signal = opts.signal ?? new AbortController().signal;
  const req: ChatRequest = {
    model: opts.model,
    messages: [
      { role: "system", content: "You write factual project briefings from documentation. You never invent facts the documents do not state." },
      { role: "user", content: briefPrompt(input) },
    ],
    tools: [],
  };
  let out = "";
  try {
    for await (const ev of opts.provider.chat(req, signal)) {
      if (ev.type === "text-delta") out += ev.text;
      else if (ev.type === "error") throw new Error(ev.message);
    }
  } catch (e) {
    return { ok: false, message: `Project brief failed (${e instanceof Error ? e.message : String(e)}) — tracing can still run without it.` };
  }
  const body = out.replace(/<\/?think>/gi, "").trim();
  if (!body) return { ok: false, message: "The brief came back empty — tracing can still run without it." };
  await saveBrief(opts.cwd, body, { hash: input.hash, sources: input.sources.map((s) => s.file), writtenAt: Date.now(), model: opts.model });
  return { ok: true, message: `**Project brief** written from ${input.sources.length} document(s): ${input.sources.slice(0, 6).map((s) => `\`${s.file}\``).join(", ")}` };
}
