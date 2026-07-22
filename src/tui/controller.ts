import type { BoardCardView, ProgressEvent } from "../engine/progress.js";
import type { AskOpts } from "../engine/review.js";
import type { ToolActivity } from "../core/types.js";
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

/** Chat-flow items: user/assistant messages, plus inline tool activity (file writes/edits). */
export type TranscriptItem =
  | { role: "user" | "assistant"; text: string }
  | { kind: "tool"; activity: ToolActivity };

/** A sub-agent currently working a task (IN-PROGRESS card) — shown live under the input. */
export interface RunningAgent {
  id: string;
  title: string;
  model?: string;
  startedAt: number;
}

export interface TuiState {
  phase: string;
  detail?: string;
  cards: BoardCardView[];
  pending?: { question: string; options?: string[]; multiSelect?: boolean };
  mode?: "input" | "running" | "picker";
  transcript: TranscriptItem[];
  queued: number; // prompts typed while a job is running, waiting to run next
  meta?: TurnMeta;
  // stage "role": the list is role names (pick which role to set); "model": the list is models.
  // role set (+ stage "model") → the picked model is applied to THAT role; role undefined → session-wide (/model).
  picker?: { models: string[]; loading: boolean; error?: string; stage: "role" | "model"; role?: string };
  currentModel: string;
  runningAgents: RunningAgent[]; // IN-PROGRESS cards → live agent panel under the input
}

/** Bridges runJob's async seams (onEvent + ask) to React state. Pure state machine. */
export class TuiController {
  private state: TuiState = { phase: "", cards: [], transcript: [], queued: 0, currentModel: "", runningAgents: [] };
  private pendingResolve?: (s: string) => void;
  private taskResolve?: (t: string) => void;
  private queue: string[] = []; // prompts submitted while running → drained by awaitTask
  private listeners = new Set<() => void>();
  private agentStarts = new Map<string, number>(); // card id → when it entered IN-PROGRESS (our clock)
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
    else if (ev.kind === "board") this.state = { ...this.state, cards: ev.cards, runningAgents: this.deriveAgents(ev.cards) };
    // refined: swap the raw prompt for the refined one live (the coach/pipeline only ever sees the refine),
    // so the transcript shows what was actually handed downstream. endRun does the same as a fallback.
    else this.state = { ...this.state, transcript: replaceLastUser(this.state.transcript, ev.refinedPrompt) };
    this.notify();
  };

  /** Reconciles the running-agent list from the board: IN-PROGRESS cards, each with a stable start time. */
  private deriveAgents(cards: BoardCardView[]): RunningAgent[] {
    const inProgress = cards.filter((c) => c.column === "IN-PROGRESS");
    const live = new Set(inProgress.map((c) => c.id));
    for (const id of this.agentStarts.keys()) if (!live.has(id)) this.agentStarts.delete(id); // finished → drop
    return inProgress.map((c) => {
      let startedAt = this.agentStarts.get(c.id);
      if (startedAt === undefined) { startedAt = this.now(); this.agentStarts.set(c.id, startedAt); } // newly started
      return { id: c.id, title: c.title, model: c.model, startedAt };
    });
  }

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

  // arrow-bound: wired to deps.onActivity → write/edit tools push here → inline in the chat flow.
  pushActivity = (a: ToolActivity): void => {
    this.state = { ...this.state, transcript: [...this.state.transcript, { kind: "tool", activity: a }] };
    this.notify();
  };

  // arrow-bound: passed as LineReader → reused with makeAskUser/makeApprove/makeAskHuman.
  // opts.options → the UI renders a checkbox/radio selector instead of the free-text input.
  ask = (question: string, opts?: AskOpts): Promise<string> =>
    new Promise<string>((resolve) => {
      this.pendingResolve = resolve;
      this.state = { ...this.state, pending: { question, options: opts?.options, multiSelect: opts?.multiSelect } };
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
    this.agentStarts.clear();
    this.state = {
      ...this.state,
      mode: "running", cards: [], phase: "", detail: undefined, pending: undefined, runningAgents: [],
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
    this.agentStarts.clear();
    this.state = { ...this.state, mode: "input", transcript: t, meta, runningAgents: [] };
    this.notify();
  }

  /** /model: pick a model for the whole session (role undefined). */
  openPicker(): void {
    this.state = { ...this.state, mode: "picker", picker: { models: [], loading: true, stage: "model" } };
    this.notify();
  }

  /** /roles setmodel step 1: pick which role to set (list of role names). */
  openRolePicker(roles: string[]): void {
    this.state = { ...this.state, mode: "picker", picker: { models: roles, loading: false, stage: "role" } };
    this.notify();
  }

  /** /roles setmodel step 2: a role was chosen → now pick a model for it (App fetches the model list). */
  chooseRole(role: string): void {
    this.state = { ...this.state, picker: { models: [], loading: true, stage: "model", role } };
    this.notify();
  }

  setPickerModels(models: string[]): void {
    const p = this.state.picker;
    if (!p) return;
    this.state = { ...this.state, picker: { ...p, models, loading: false } };
    this.notify();
  }

  setPickerError(msg: string): void {
    const p = this.state.picker;
    if (!p) return;
    this.state = { ...this.state, picker: { ...p, models: [], loading: false, error: msg } };
    this.notify();
  }

  applyModel(model: string): void {
    this.state = { ...this.state, mode: "input", picker: undefined, currentModel: model };
    this.notify();
  }

  /** Applies a model to a single role (per-role) and confirms it in the transcript. */
  applyRoleModel(role: string, model: string): void {
    this.state = {
      ...this.state,
      mode: "input", picker: undefined,
      transcript: [...this.state.transcript, { role: "assistant", text: `\`${role}\` → ${model}` }],
    };
    this.notify();
  }

  cancelPicker(): void {
    this.state = { ...this.state, mode: "input", picker: undefined };
    this.notify();
  }

  /** Append an assistant-style note to the transcript (used by /help). */
  note(text: string): void {
    this.state = { ...this.state, transcript: [...this.state.transcript, { role: "assistant", text }] };
    this.notify();
  }

  /** Clear the conversation transcript + the last turn's metrics (used by /clear). */
  clearTranscript(): void {
    this.state = { ...this.state, transcript: [], meta: undefined };
    this.notify();
  }
}

/** Returns a copy of the transcript with the last entry's text swapped to `text`, only if it's a user entry. */
function replaceLastUser(
  transcript: TuiState["transcript"],
  text: string,
): TuiState["transcript"] {
  const t = [...transcript];
  // Find the last user message in the current turn (skip inline tool items; stop at a previous assistant reply).
  for (let i = t.length - 1; i >= 0; i--) {
    const item = t[i];
    if ("kind" in item) continue; // tool activity → skip
    if (item.role === "assistant") break; // reached the previous turn
    if (item.role === "user") { t[i] = { role: "user", text }; break; }
  }
  return t;
}
