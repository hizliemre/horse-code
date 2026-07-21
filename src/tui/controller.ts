import type { BoardCardView, ProgressEvent } from "../engine/progress.js";
import type { UsageSample } from "../providers/meter.js";

/** Per-turn metrics shown under the input (active model + accumulated tokens + duration). */
export interface TurnMeta {
  model: string;
  promptTokens: number;
  completionTokens: number;
  startedAt?: number;
  durationMs?: number;
  running: boolean;
}

export interface TuiState {
  phase: string;
  detail?: string;
  cards: BoardCardView[];
  pending?: { question: string };
  mode?: "input" | "running";
  transcript: { role: "user" | "assistant"; text: string }[];
  queued: number; // prompts typed while a job is running, waiting to run next
  meta?: TurnMeta;
}

/** Bridges runJob's async seams (onEvent + ask) to React state. Pure state machine. */
export class TuiController {
  private state: TuiState = { phase: "", cards: [], transcript: [], queued: 0 };
  private pendingResolve?: (s: string) => void;
  private taskResolve?: (t: string) => void;
  private queue: string[] = []; // prompts submitted while running → drained by awaitTask
  private listeners = new Set<() => void>();
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  getState(): TuiState {
    return this.state;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  // arrow-bound: passed to runJob as onEvent (preserves this)
  onEvent = (ev: ProgressEvent): void => {
    if (ev.kind === "phase") this.state = { ...this.state, phase: ev.phase, detail: ev.detail };
    else if (ev.kind === "board") this.state = { ...this.state, cards: ev.cards };
    // refined: swap the raw prompt for the refined one live (the coach/pipeline only ever sees the refine),
    // so the transcript shows what was actually handed downstream. endRun does the same as a fallback.
    else this.state = { ...this.state, transcript: replaceLastUser(this.state.transcript, ev.refinedPrompt) };
    this.notify();
  };

  // arrow-bound: passed to meterProvider → accumulates the running turn's tokens + latest active model.
  onUsage = (s: UsageSample): void => {
    const m = this.state.meta ?? { model: "", promptTokens: 0, completionTokens: 0, running: true };
    this.state = {
      ...this.state,
      meta: {
        ...m,
        model: s.model || m.model,
        promptTokens: m.promptTokens + s.promptTokens,
        completionTokens: m.completionTokens + s.completionTokens,
      },
    };
    this.notify();
  };

  // arrow-bound: passed as LineReader → reused with makeAskUser/makeApprove/makeAskHuman
  ask = (question: string): Promise<string> =>
    new Promise<string>((resolve) => {
      this.pendingResolve = resolve;
      this.state = { ...this.state, pending: { question } };
      this.notify();
    });

  answer(text: string): void {
    const resolve = this.pendingResolve;
    this.pendingResolve = undefined;
    this.state = { ...this.state, pending: undefined };
    this.notify();
    resolve?.(text);
  }

  // REPL: wait for task input (mode=input); submitTask resolves it. A queued prompt (typed while the
  // previous job ran) is drained immediately so the loop keeps running without waiting for input.
  awaitTask(): Promise<string> {
    return new Promise<string>((resolve) => {
      const next = this.queue.shift();
      if (next !== undefined) {
        this.state = { ...this.state, mode: "input", transcript: [...this.state.transcript, { role: "user", text: next }], queued: this.queue.length };
        this.notify();
        resolve(next);
        return;
      }
      this.taskResolve = resolve;
      this.state = { ...this.state, mode: "input" };
      this.notify();
    });
  }

  submitTask(task: string): void {
    if (this.taskResolve) {
      const resolve = this.taskResolve;
      this.taskResolve = undefined;
      this.state = { ...this.state, transcript: [...this.state.transcript, { role: "user", text: task }] };
      this.notify();
      resolve(task);
      return;
    }
    // No consumer waiting → a job is running: queue it to run after the current one.
    this.queue.push(task);
    this.state = { ...this.state, queued: this.queue.length };
    this.notify();
  }

  beginRun(): void {
    this.state = {
      ...this.state,
      mode: "running", cards: [], phase: "", detail: undefined, pending: undefined,
      meta: { model: "", promptTokens: 0, completionTokens: 0, startedAt: this.now(), running: true },
    };
    this.notify();
  }

  endRun(report: string, refinedPrompt?: string): void {
    // Fallback replace of the last (raw) user input with the refine → the transcript always stores the
    // REFINE; the next turn's history is built from this → the coach never sees the raw prompt. (The live
    // "refined" event usually did this already; harmless to repeat.) Then append the assistant reply.
    const t = refinedPrompt ? replaceLastUser(this.state.transcript, refinedPrompt) : [...this.state.transcript];
    t.push({ role: "assistant", text: report });
    const m = this.state.meta;
    const meta: TurnMeta | undefined = m
      ? { ...m, running: false, durationMs: m.startedAt !== undefined ? this.now() - m.startedAt : m.durationMs }
      : undefined;
    this.state = { ...this.state, mode: "input", transcript: t, meta };
    this.notify();
  }
}

/** Returns a copy of the transcript with the last entry's text swapped to `text`, only if it's a user entry. */
function replaceLastUser(
  transcript: TuiState["transcript"],
  text: string,
): TuiState["transcript"] {
  const t = [...transcript];
  if (t.length && t[t.length - 1].role === "user") {
    t[t.length - 1] = { role: "user", text };
  }
  return t;
}
