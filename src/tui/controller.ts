import type { BoardCardView, ProgressEvent } from "../engine/progress.js";
import type { AskOpts } from "../engine/review.js";
import type { ToolActivity } from "../core/types.js";
import type { UsageSample } from "../providers/meter.js";
import { phaseNarration } from "./labels.js";

/** Per-turn metrics shown under the input (active model + accumulated tokens + duration). */
export interface TurnMeta {
  model: string;
  promptTokens: number; // Σ billed input over every LLM call in the turn (re-sent context bills per call — no caching)
  completionTokens: number; // Σ generated tokens
  calls: number; // number of LLM calls the turn made (refiner + each coach tool-round + summarizer + subagents)
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
  // role set (+ stage "model") → build a fallback CHAIN: `picked` accumulates over `slots` model picks;
  // role undefined → session-wide (/model), a single pick.
  picker?: { models: string[]; loading: boolean; error?: string; stage: "role" | "model" | "mode"; role?: string; note?: string; picked?: string[]; slots?: number };
  currentModel: string;
  runningAgents: RunningAgent[]; // IN-PROGRESS cards → live agent panel under the input
  attachments: number; // count of pasted images staged for the next prompt (shown under the input)
  nextSteps: string[]; // coach-suggested follow-ups (run with /next N); cleared when a new turn starts
}

/** Bridges runJob's async seams (onEvent + ask) to React state. Pure state machine. */
export class TuiController {
  private state: TuiState = { phase: "", cards: [], transcript: [], queued: 0, currentModel: "", runningAgents: [], attachments: 0, nextSteps: [] };
  private pendingResolve?: (s: string) => void;
  private taskResolve?: (t: string) => void;
  private queue: string[] = []; // prompts submitted while running → drained by awaitTask
  private pendingAttachments: string[] = []; // pasted image data URIs staged for the next submit
  private turnAttachments: string[] = []; // snapshot handed to the running job (drained by takeAttachments)
  private inbox: string[] = []; // "by-the-way" notes typed mid-run → folded into the running coach turn
  private listeners = new Set<() => void>();
  private agentStarts = new Map<string, number>(); // card id → when it entered IN-PROGRESS (our clock)
  private lastNarrated?: string; // last spec-kit phase narrated into the flow (dedup)
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
    if (ev.kind === "phase") {
      let transcript = this.state.transcript;
      // Narrate the spec-kit authoring phases into the chat flow (persistent progress + a heads-up that
      // the interactive steps may ask questions) — the transient shimmer alone reads as "stuck".
      const narration = phaseNarration(ev.phase);
      if (narration && this.lastNarrated !== ev.phase) {
        this.lastNarrated = ev.phase;
        transcript = [...transcript, { role: "assistant", text: narration }];
      }
      this.state = { ...this.state, phase: ev.phase, detail: ev.detail, transcript };
    }
    else if (ev.kind === "board") this.state = { ...this.state, cards: ev.cards, runningAgents: this.deriveAgents(ev.cards) };
    // agents: ad-hoc sub-agents not backed by the board (the review council) → shown in the live-agents panel.
    else if (ev.kind === "agents") this.state = { ...this.state, runningAgents: this.setAgents(ev.agents) };
    // refined: swap the raw prompt for the refined one live (the coach/pipeline only ever sees the refine),
    // so the transcript shows what was actually handed downstream. endRun does the same as a fallback.
    else this.state = { ...this.state, transcript: replaceLastUser(this.state.transcript, ev.refinedPrompt) };
    this.notify();
  };

  /** Reconciles ad-hoc sub-agents (not board-backed, e.g. the review council) with stable start times. */
  private setAgents(agents: { id: string; title: string; model: string }[]): RunningAgent[] {
    const live = new Set(agents.map((a) => a.id));
    for (const id of this.agentStarts.keys()) if (!live.has(id)) this.agentStarts.delete(id);
    return agents.map((a) => {
      let startedAt = this.agentStarts.get(a.id);
      if (startedAt === undefined) { startedAt = this.now(); this.agentStarts.set(a.id, startedAt); }
      return { id: a.id, title: a.title, model: a.model, startedAt };
    });
  }

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
    const m = this.state.meta;
    // Only count usage while a turn is actually running. Late samples from aborted parallel work (e.g. sibling
    // councilors still winding down after an error) must NOT keep inflating the frozen "done" line.
    if (!m || !m.running) return;
    this.state = {
      ...this.state,
      meta: {
        ...m,
        model: s.model || m.model,
        promptTokens: m.promptTokens + s.promptTokens,
        completionTokens: m.completionTokens + s.completionTokens,
        calls: (m.calls ?? 0) + 1, // one usage event = one LLM call
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
    const question = this.state.pending?.question;
    this.pendingResolve = undefined;
    // Record the exchange in the chat flow so the interview history (question + the answer you gave) stays
    // visible — otherwise each new question replaces the last and the Q&A is lost.
    let transcript = this.state.transcript;
    if (question !== undefined) {
      const clean = question.replace(/^\s*\[(question|permission|human)\]\s*/, "").trim();
      transcript = [...transcript, { role: "assistant", text: clean }, { role: "user", text }];
    }
    this.state = { ...this.state, pending: undefined, transcript };
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
      // Hand the staged images to this turn; clear the staging area.
      this.turnAttachments = this.pendingAttachments;
      this.pendingAttachments = [];
      this.state = { ...this.state, transcript: [...this.state.transcript, { role: "user", text: task }], attachments: 0 };
      this.notify();
      resolve(task);
      return;
    }
    // No consumer waiting → a job is running: queue it to run after the current one. (Images are not
    // carried on queued prompts; drop the staging area so the count doesn't linger.)
    this.queue.push(task);
    this.pendingAttachments = [];
    this.state = { ...this.state, queued: this.queue.length, attachments: 0 };
    this.notify();
  }

  /** Stage a pasted image (base64 data URI) for the next prompt. */
  addAttachment(dataUri: string): void {
    this.pendingAttachments = [...this.pendingAttachments, dataUri];
    this.state = { ...this.state, attachments: this.pendingAttachments.length };
    this.notify();
  }

  /** Discard the staged images (Esc / cleared input). */
  clearAttachments(): void {
    if (this.pendingAttachments.length === 0) return;
    this.pendingAttachments = [];
    this.state = { ...this.state, attachments: 0 };
    this.notify();
  }

  /** The images attached to the just-submitted turn (drained once, handed to the job). */
  takeAttachments(): string[] {
    const a = this.turnAttachments;
    this.turnAttachments = [];
    return a;
  }

  /** "By-the-way": queue a note to fold into the running turn (with a transcript confirmation). */
  addInboxNote(text: string): void {
    this.inbox.push(text);
    this.note(`↳ by-the-way (folded into the running turn): ${text}`);
  }

  /** Loop poll: take the next queued by-the-way note, or undefined. */
  takeInboxNote(): string | undefined {
    return this.inbox.shift();
  }

  /** Drain any by-the-way notes the running turn never consumed (run them as fresh turns instead). */
  drainInbox(): string[] {
    const n = this.inbox;
    this.inbox = [];
    return n;
  }

  beginRun(): void {
    this.agentStarts.clear();
    this.lastNarrated = undefined; // re-narrate phases for the new turn
    this.state = {
      ...this.state,
      mode: "running", cards: [], phase: "", detail: undefined, pending: undefined, runningAgents: [], nextSteps: [],
      meta: { model: "", promptTokens: 0, completionTokens: 0, calls: 0, startedAt: this.now(), running: true },
    };
    this.notify();
  }

  /**
   * Enter a lightweight "running" state for a non-job async activity (e.g. /roles adjust): the status line
   * gets the shimmer + live elapsed timer, and onUsage accumulates token metrics into meta as calls arrive.
   */
  startBusy(phase: string, model = ""): void {
    this.state = {
      ...this.state,
      mode: "running", phase, detail: undefined,
      meta: { model, promptTokens: 0, completionTokens: 0, calls: 0, startedAt: this.now(), running: true },
    };
    this.notify();
  }

  /** Leave the busy state → freezes the metrics into a done line ("…for Xs · ↑ ↓ · N calls"). */
  endBusy(): void {
    const m = this.state.meta;
    const meta: TurnMeta | undefined = m
      ? { ...m, running: false, durationMs: m.startedAt !== undefined ? this.now() - m.startedAt : m.durationMs }
      : undefined;
    this.state = { ...this.state, mode: "input", meta };
    this.notify();
  }

  /** Store the coach's suggested follow-ups (rendered under the input; run with /next N). */
  setNextSteps(steps: string[]): void {
    this.state = { ...this.state, nextSteps: steps };
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

  /** /mode: pick the permission mode from the keyboard (list of modes; `note` describes each). */
  openModePicker(modes: string[], note?: string): void {
    this.state = { ...this.state, mode: "picker", picker: { models: modes, loading: false, stage: "mode", note } };
    this.notify();
  }

  /** Applies a picked permission mode and confirms it in the transcript. */
  applyMode(mode: string, desc: string): void {
    this.state = {
      ...this.state,
      mode: "input", picker: undefined,
      transcript: [...this.state.transcript, { role: "assistant", text: `Permission mode → **${mode}** — ${desc}.` }],
    };
    this.notify();
  }

  /** /roles setmodel step 2: a role was chosen → build its fallback chain over `slots` model picks. */
  chooseRole(role: string, slots = 3): void {
    this.state = { ...this.state, picker: { models: [], loading: true, stage: "model", role, picked: [], slots } };
    this.notify();
  }

  /**
   * Records a model pick for the current chain slot. Returns true when the chain is complete (the caller then
   * applies it); false when more slots remain (advances to the next slot → App re-fetches, excluding picks).
   */
  addChainModel(model: string): boolean {
    const p = this.state.picker;
    if (!p || p.stage !== "model" || !p.role) return true;
    const picked = [...(p.picked ?? []), model];
    if (picked.length >= (p.slots ?? 1)) return true; // complete → caller finalizes
    this.state = { ...this.state, picker: { ...p, picked, models: [], loading: true } };
    this.notify();
    return false;
  }

  setPickerModels(models: string[], note?: string): void {
    const p = this.state.picker;
    if (!p) return;
    this.state = { ...this.state, picker: { ...p, models, loading: false, note } };
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

  /** Applies a model chain to a single role (per-role) and confirms it in the transcript, inline. */
  applyRoleModel(role: string, models: string | string[]): void {
    const chain = typeof models === "string" ? [models] : models;
    const body = chain.length ? `${chain[0]}${chain.slice(1).map((m) => `  ↳ ${m}`).join("")}` : "—";
    this.state = {
      ...this.state,
      mode: "input", picker: undefined,
      transcript: [...this.state.transcript, { role: "assistant", text: `\`${role}\` → ${body}` }],
    };
    this.notify();
  }

  cancelPicker(): void {
    this.state = { ...this.state, mode: "input", picker: undefined };
    this.notify();
  }

  /**
   * Return an appender that live-updates a single assistant note. The note is created LAZILY on the first
   * append (so a slow LLM doesn't leave an empty bubble sitting there); if no delta ever arrives, no note is
   * added at all. Used to stream an LLM reasoning live (e.g. /roles adjust).
   */
  streamNote(initial = ""): (delta: string) => void {
    let idx = -1;
    let acc = initial;
    return (delta: string): void => {
      acc += delta;
      if (idx < 0) { idx = this.state.transcript.length; this.state = { ...this.state, transcript: [...this.state.transcript, { role: "assistant", text: acc }] }; } // create on first delta
      else { const t = [...this.state.transcript]; if (t[idx] && "role" in t[idx]) t[idx] = { role: "assistant", text: acc }; this.state = { ...this.state, transcript: t }; }
      this.notify();
    };
  }

  /** Append an assistant-style note to the transcript (used by /help). */
  note(text: string): void {
    this.state = { ...this.state, transcript: [...this.state.transcript, { role: "assistant", text }] };
    this.notify();
  }

  /** Clear the conversation transcript + the last turn's metrics (used by /clear). */
  clearTranscript(): void {
    this.state = { ...this.state, transcript: [], meta: undefined, nextSteps: [] };
    this.notify();
  }

  /** Replace the transcript with a resumed session's messages (used by /resume). */
  loadTranscript(messages: { role: "user" | "assistant"; text: string }[]): void {
    this.state = { ...this.state, transcript: messages.map((m) => ({ role: m.role, text: m.text })), meta: undefined };
    this.notify();
  }

  /** The conversation messages only (tool-activity items excluded) — persisted for resume. */
  messages(): { role: "user" | "assistant"; text: string }[] {
    return this.state.transcript.filter(
      (m): m is { role: "user" | "assistant"; text: string } => !("kind" in m),
    );
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
