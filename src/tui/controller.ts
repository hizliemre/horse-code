import type { BoardCardView, ProgressEvent } from "../engine/progress.js";

export interface TuiState {
  phase: string;
  detail?: string;
  cards: BoardCardView[];
  pending?: { question: string };
  mode?: "input" | "running";
  transcript: { role: "user" | "assistant"; text: string }[];
}

/** Bridges runJob's async seams (onEvent + ask) to React state. Pure state machine. */
export class TuiController {
  private state: TuiState = { phase: "", cards: [], transcript: [] };
  private pendingResolve?: (s: string) => void;
  private taskResolve?: (t: string) => void;
  private listeners = new Set<() => void>();

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
    else this.state = { ...this.state, cards: ev.cards };
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

  // REPL: wait for task input (mode=input); submitTask resolves it.
  awaitTask(): Promise<string> {
    return new Promise<string>((resolve) => {
      this.taskResolve = resolve;
      this.state = { ...this.state, mode: "input" };
      this.notify();
    });
  }

  submitTask(task: string): void {
    const resolve = this.taskResolve;
    this.taskResolve = undefined;
    this.state = { ...this.state, transcript: [...this.state.transcript, { role: "user", text: task }] };
    this.notify();
    resolve?.(task);
  }

  beginRun(): void {
    this.state = { ...this.state, mode: "running", cards: [], phase: "", detail: undefined, pending: undefined };
    this.notify();
  }

  endRun(report: string, refinedPrompt?: string): void {
    // Replace the last (raw) user input with the refined version → the transcript always stores the
    // REFINE; the next turn's history is built from this → the coach never sees the raw prompt. Then append the assistant reply.
    const t = [...this.state.transcript];
    if (refinedPrompt && t.length && t[t.length - 1].role === "user") {
      t[t.length - 1] = { role: "user", text: refinedPrompt };
    }
    t.push({ role: "assistant", text: report });
    this.state = { ...this.state, mode: "input", transcript: t };
    this.notify();
  }
}
