import type { BoardCardView, ProgressEvent } from "../engine/progress.js";

export interface TuiState {
  phase: string;
  detail?: string;
  cards: BoardCardView[];
  pending?: { question: string };
  mode?: "input" | "running";
  lastReport?: string;
}

/** runJob'un async seam'lerini (onEvent + ask) React state'ine köprüler. Saf state-machine. */
export class TuiController {
  private state: TuiState = { phase: "", cards: [] };
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

  // arrow-bound: runJob'a onEvent olarak geçilir (this korunur)
  onEvent = (ev: ProgressEvent): void => {
    if (ev.kind === "phase") this.state = { ...this.state, phase: ev.phase, detail: ev.detail };
    else this.state = { ...this.state, cards: ev.cards };
    this.notify();
  };

  // arrow-bound: LineReader olarak geçilir → makeAskUser/makeApprove/makeAskHuman ile reuse
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

  // REPL: görev-input beklet (mode=input); submitTask çözer.
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
    resolve?.(task);
  }

  beginRun(): void {
    this.state = { ...this.state, mode: "running", cards: [], phase: "", detail: undefined, pending: undefined };
    this.notify();
  }

  endRun(report: string): void {
    this.state = { ...this.state, mode: "input", lastReport: report };
    this.notify();
  }
}
