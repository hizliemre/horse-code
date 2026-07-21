import type { BoardCardView, ProgressEvent } from "../engine/progress.js";

export interface TuiState {
  phase: string;
  detail?: string;
  cards: BoardCardView[];
  pending?: { question: string };
}

/** runJob'un async seam'lerini (onEvent + ask) React state'ine köprüler. Saf state-machine. */
export class TuiController {
  private state: TuiState = { phase: "", cards: [] };
  private pendingResolve?: (s: string) => void;
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
}
