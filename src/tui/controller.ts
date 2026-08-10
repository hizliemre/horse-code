import type { BoardCardView, ProgressEvent } from "../engine/progress.js";
import type { AskOpts, AskChoice } from "../engine/review.js";
import type { ToolActivity } from "../core/types.js";
import type { UsageSample } from "../providers/meter.js";
import { phaseNarration, PENDING_TAG } from "./labels.js";

/** Per-turn metrics shown under the input (active model + accumulated tokens + duration). */
export interface TurnMeta {
  model: string;
  promptTokens: number; // Σ billed input over every LLM call in the turn (re-sent context bills per call — no caching)
  completionTokens: number; // Σ generated tokens
  cachedTokens: number; // Σ of promptTokens the backend served from its prefix cache (billed at a fraction)
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
/** The last few calls an agent made, kept on its own row instead of in the conversation. */
export interface AgentCall {
  tool: string;
  target: string;
  ok?: boolean;
}

/** How much of an agent's tool history its row keeps. The panel shows the tail; the rest is not read. */
export const MAX_AGENT_CALLS = 8;

export interface RunningAgent {
  id: string;
  title: string;
  model?: string;
  /** The role doing the work — "coder", "senior-designer", a review lens. */
  role?: string;
  /** This agent's most recent tool calls, newest last. Kept for the activity line, not shown as a list. */
  calls?: AgentCall[];
  /** How many calls it has made in total; the kept list is only the tail. */
  callCount?: number;
  startedAt: number;
  status?: string; // set when the agent finishes → its result (e.g. "REJECT · C:2 M:1 L:0"), shown inline
  doneAt?: number; // freeze the row's timer once the agent has reported its result
  promptTokens?: number; // tokens this agent burned (↑), shown in the row's parens like the main shimmer
  completionTokens?: number; // tokens this agent produced (↓)
}

export interface TuiState {
  phase: string;
  detail?: string;
  cards: BoardCardView[];
  pending?: { question: string; options?: (string | AskChoice)[]; multiSelect?: boolean };
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
  /** Which agent row is highlighted (↑/↓ while a job runs); undefined = none, and no detail panel. */
  agentCursor?: number;
  liveActivity?: string; // transient "writing <file> · N chars" while a tool call is being generated
  attachments: number; // count of pasted images staged for the next prompt (shown under the input)
  nextSteps: string[]; // coach-suggested follow-ups (run with /next N); cleared when a new turn starts
}

/**
 * How many transcript items the live view keeps.
 *
 * The renderer flattens the WHOLE transcript into styled lines on every frame and then slices a viewport out
 * of it, so the per-frame cost grows without bound. A 7.5-hour run reached a 4 GB heap and died with
 * "JavaScript heap out of memory" — the transcript itself plus a fresh full-length line array on every render.
 * The window is far larger than any scrollback anyone reads, and the full conversation is persisted separately
 * by the session store, so nothing durable is lost by dropping the oldest items from the live view.
 */
export const MAX_TRANSCRIPT_ITEMS = 1_500;

/** See addInboxNote: the window a folded note waits before it is answered separately instead. */
export const INBOX_FOLD_WINDOW_MS = 90_000;
/**
 * How many scrolled-off chat turns are kept for a resume.
 *
 * Generous — a resume wants context — but finite. Unbounded, it was one of the structures a five-hour run
 * grew until the heap gave out.
 */
export const MAX_ARCHIVED = 4_000;

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
  // Board-backed rows are REBUILT from the card list on every board change, so anything learned about a row
  // between rebuilds (its running token spend, the model actually serving it) would be lost each time.
  private agentTokens = new Map<string, { promptTokens: number; completionTokens: number }>();
  private agentModels = new Map<string, string>();
  private lastNarrated?: string; // last spec-kit phase narrated into the flow (dedup)
  // The VIEW's transcript is windowed (see MAX_TRANSCRIPT_ITEMS), but the saved session must not be: capping
  // what is persisted would silently drop the earliest turns of a long run. Chat text is small — it was the
  // tool activity and the per-frame re-flatten that blew up memory, not the messages.
  /**
   * Chat turns scrolled off the visible transcript, kept so a resumed session has its history.
   *
   * Bounded, because it is not: a five-hour run archives every turn it drops and holds them all. The oldest
   * turns are also the least useful to a resume — what matters is what was decided recently — so the window
   * is the tail.
   */
  private archived: { role: "user" | "assistant"; text: string }[] = [];

  /**
   * Windows the on-screen transcript, ARCHIVING any chat message it drops.
   *
   * Done in one place rather than at each append site so no path can silently lose a turn — including
   * `streamNote`, which mutates an item in place as deltas arrive and has no completion event to hook.
   */
  /**
   * A run of tool calls is over the moment anything else is said.
   *
   * Settled here rather than at each of the nine places that append to the transcript: one of them would be
   * missed, and a row left saying "Running 6 shell commands…" forever is worse than never having said it.
   */
  private settleTools(t: TranscriptItem[]): TranscriptItem[] {
    return t.map((m, i) => {
      if (i === t.length - 1 || !("kind" in m) || m.kind !== "tool" || m.activity.settled) return m;
      return { kind: "tool" as const, activity: { ...m.activity, settled: true } };
    });
  }

  private cap(items: TranscriptItem[]): TranscriptItem[] {
    const t = this.settleTools(items);
    if (t.length <= MAX_TRANSCRIPT_ITEMS) return t;
    const cut = t.length - MAX_TRANSCRIPT_ITEMS;
    for (const m of t.slice(0, cut)) if (!("kind" in m)) this.archived.push(m);
    if (this.archived.length > MAX_ARCHIVED) this.archived.splice(0, this.archived.length - MAX_ARCHIVED);
    return t.slice(cut);
  }
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
        transcript = this.cap([...transcript, { role: "assistant", text: narration }]);
      }
      this.state = { ...this.state, phase: ev.phase, detail: ev.detail, transcript, liveActivity: undefined };
    }
    else if (ev.kind === "board") this.state = { ...this.state, cards: ev.cards, runningAgents: this.deriveAgents(ev.cards) };
    // agents: ad-hoc sub-agents not backed by the board (the review council) → shown in the live-agents panel.
    else if (ev.kind === "agents") this.state = { ...this.state, runningAgents: this.setAgents(ev.agents) };
    // A sub-agent finished → stamp its result on that row (and freeze its timer) the moment it lands, so
    // early finishers show their verdict + finding counts immediately instead of all at once.
    // The chain slid → rename the row to whichever model is actually serving it now.
    else if (ev.kind === "agent-model") { this.agentModels.set(ev.id, ev.model); this.state = { ...this.state, runningAgents: this.state.runningAgents.map((a) => a.id === ev.id ? { ...a, model: ev.model } : a) }; }
    // Running total, no status/doneAt: the row keeps ticking, it just also shows what it has spent so far.
    else if (ev.kind === "agent-usage") { this.agentTokens.set(ev.id, { promptTokens: ev.promptTokens, completionTokens: ev.completionTokens }); this.state = { ...this.state, runningAgents: this.state.runningAgents.map((a) => a.id === ev.id ? { ...a, promptTokens: ev.promptTokens, completionTokens: ev.completionTokens } : a) }; }
    else if (ev.kind === "agent-result") this.state = { ...this.state, runningAgents: this.state.runningAgents.map((a) => a.id === ev.id ? { ...a, status: ev.status, doneAt: this.now(), promptTokens: ev.promptTokens, completionTokens: ev.completionTokens } : a) };
    // note: a live transcript line from deep in the pipeline (council findings, judge decision).
    else if (ev.kind === "note") this.state = { ...this.state, transcript: this.cap([...this.state.transcript, { role: "assistant", text: ev.text }]) };
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
      return { id: a.id, title: a.title, model: a.model, startedAt, ...this.agentTokens.get(a.id), ...this.workOf(a.id) };
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
      if (c.model) this.agentModels.set(c.id, c.model);
      const model = c.model || this.agentModels.get(c.id);
      return { id: c.id, title: c.title, ...(model ? { model } : {}), ...(c.role ? { role: c.role } : {}), startedAt, ...this.agentTokens.get(c.id), ...this.workOf(c.id) };
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
        cachedTokens: m.cachedTokens + (s.cachedTokens ?? 0),
        promptTokens: m.promptTokens + s.promptTokens,
        completionTokens: m.completionTokens + s.completionTokens,
        calls: (m.calls ?? 0) + 1, // one usage event = one LLM call
      },
    };
    this.notify();
  };

  /** Per-agent tool history, kept outside the state so a row rebuild (board event) does not lose it. */
  private agentCalls = new Map<string, { calls: AgentCall[]; count: number }>();

  private workOf(id: string): { calls?: AgentCall[]; callCount?: number } {
    const w = this.agentCalls.get(id);
    return w ? { calls: w.calls, callCount: w.count } : {};
  }

  /**
   * Files a tool call under its agent. Returns false when no live row owns it — then it is the coach's own
   * call and belongs in the conversation, where a direct question's work should be visible.
   */
  private recordAgentCall(a: ToolActivity): boolean {
    const id = a.agent as string;
    if (!this.state.runningAgents.some((x) => x.id === id)) return false;
    const w = this.agentCalls.get(id) ?? { calls: [], count: 0 };
    const call: AgentCall = { tool: a.tool, target: a.target, ...(a.ok === false ? { ok: false } : {}) };
    const last = w.calls[w.calls.length - 1];
    // A row of identical repeats says nothing new; only the count moves.
    const calls = last && last.tool === call.tool && last.target === call.target
      ? w.calls
      : [...w.calls, call].slice(-MAX_AGENT_CALLS);
    this.agentCalls.set(id, { calls, count: w.count + 1 });
    this.state = {
      ...this.state,
      liveActivity: undefined,
      runningAgents: this.state.runningAgents.map((x) => x.id === id ? { ...x, ...this.workOf(id) } : x),
    };
    this.notify();
    return true;
  }

  /**
   * Moves the highlight in the running-agents panel; undefined selects nothing.
   *
   * Clamped rather than wrapped: the list changes under the cursor as agents start and finish, and a cursor
   * that wraps would jump to the far end of a list the user is not looking at.
   */
  selectAgent(delta: number): void {
    const n = this.state.runningAgents.length;
    if (n === 0) { if (this.state.agentCursor !== undefined) { this.state = { ...this.state, agentCursor: undefined }; this.notify(); } return; }
    const cur = this.state.agentCursor;
    const next = cur === undefined ? (delta > 0 ? 0 : n - 1) : Math.min(n - 1, Math.max(0, cur + delta));
    this.state = { ...this.state, agentCursor: next };
    this.notify();
  }

  /** Drops the highlight (Esc, or the panel emptying). */
  clearAgentSelection(): void {
    if (this.state.agentCursor === undefined) return;
    this.state = { ...this.state, agentCursor: undefined };
    this.notify();
  }

  /**
   * Records a tool call in the chat, folding a run of calls to the same tool into one row.
   *
   * Every executed tool reaching the chat was the right call — the record of what an agent did was being
   * lost — but a planning agent reads the same two files sixty times, and sixty rows of
   * `read_file(spec.md) · ---` bury the handful that carry information: the failures, and the searches that
   * found nothing.
   *
   * Folded only while the run is UNBROKEN and successful. A failure ends the run and gets its own row: it is
   * the thing worth seeing, and averaging it into a count is how it would stop being noticed. A row with a
   * diff (a write or an edit) is never folded either — its content is the point.
   */
  pushActivity = (a: ToolActivity): void => {
    // Attributed to an agent → it belongs to that agent's row, not to the conversation. Five implementers
    // running at once produced one interleaved flood in which nothing could be traced to anyone; the panel
    // below the input is where "who did what" is answerable.
    if (a.agent !== undefined && this.recordAgentCall(a)) return;
    const t = [...this.state.transcript];
    const last = t[t.length - 1];
    // A row with a diff (a write or an edit) is never folded: its content is the point.
    const foldable = (x: ToolActivity): boolean => x.summary !== undefined;
    if (last && "kind" in last && last.kind === "tool" && foldable(last.activity) && foldable(a)) {
      const runs = last.activity.runs ?? [{ target: last.activity.target, count: 1 }];
      const hit = runs.find((r) => r.target === a.target);
      if (hit) hit.count++;
      else runs.push({ target: a.target, count: 1 });
      // Which tools, and how many of each: the tool changing no longer breaks the run.
      const tools = last.activity.tools ?? [{ tool: last.activity.tool, count: 1 }];
      const seen = tools.find((x) => x.tool === a.tool);
      if (seen) seen.count++;
      else tools.push({ tool: a.tool, count: 1 });
      const failed = (last.activity.failed ?? (last.activity.ok === false ? 1 : 0)) + (a.ok === false ? 1 : 0);
      // The newest outcome replaces the old one: a summary of the run's last call beats a stale first one.
      t[t.length - 1] = { kind: "tool", activity: { ...a, runs, tools, failed, settled: false } };
    } else {
      t.push({ kind: "tool", activity: { ...a, ...(a.ok === false ? { failed: 1 } : {}) } });
    }
    // The tool actually ran → its inline block replaces the transient "writing…" progress line.
    this.state = { ...this.state, liveActivity: undefined, transcript: this.cap(t) };
    this.notify();
  };

  // arrow-bound: wired to deps.onLiveActivity → live "writing <file> · N chars" while a tool call is generated.
  setLiveActivity = (label: string): void => {
    this.state = { ...this.state, liveActivity: label || undefined };
    this.notify();
  };

  // arrow-bound: passed as LineReader → reused with makeAskUser/makeApprove/makeAskHuman.
  // opts.options → the UI renders a checkbox/radio selector instead of the free-text input.
  /**
   * Set by a cancel, cleared when the next run begins.
   *
   * Cancelling answered the question with an empty string — and the agent, handed an empty answer, simply
   * asked another one. Reported live: a choice question was cancelled, a free-text question took its place
   * immediately, and Ctrl+C on THAT one produced a third. The abort had fired every time; the run just never
   * reached a point where it looks at the signal, because it was busy asking.
   *
   * A cancelled run therefore answers instantly and shows nothing: the phase unwinds through empty answers
   * to the next place that checks `signal.aborted`, which is where the cancel actually lands.
   */
  private cancelled = false;

  ask = (question: string, opts?: AskOpts): Promise<string> =>
    this.cancelled ? Promise.resolve("") : new Promise<string>((resolve) => {
      this.pendingResolve = resolve;
      this.state = { ...this.state, pending: { question, options: opts?.options, multiSelect: opts?.multiSelect } };
      this.notify();
    });

  /**
   * Releases an agent that is blocked on a question, so a cancel can actually take.
   *
   * `ask()` hands out a promise that only `answer()` resolves. Cancelling aborted the job's signal and left
   * that promise pending for ever — the agent stayed parked on a question nobody could withdraw, and the
   * screen kept the answer box open. Reported as "Ctrl+C does not cancel a question", and it was exactly
   * true: the keystroke was handled, the signal was aborted, and nothing moved.
   *
   * Answered with an empty string rather than rejected: every caller of `ask` already handles an empty
   * answer (it is what someone pressing Enter gives), and a rejection would surface as a crash in whichever
   * phase happened to be asking.
   */
  cancelPending(): void {
    this.cancelled = true;
    const resolve = this.pendingResolve;
    this.pendingResolve = undefined;
    if (this.state.pending !== undefined) this.state = { ...this.state, pending: undefined };
    resolve?.("");
    this.notify();
  }

  answer(text: string): void {
    const resolve = this.pendingResolve;
    const question = this.state.pending?.question;
    this.pendingResolve = undefined;
    // Record the exchange in the chat flow so the interview history (question + the answer you gave) stays
    // visible — otherwise each new question replaces the last and the Q&A is lost.
    let transcript = this.state.transcript;
    if (question !== undefined) {
      // The parser's own pattern, not a second copy of it — see PENDING_TAG for what the copy cost.
      const clean = question.replace(PENDING_TAG, "").trim();
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
        this.state = { ...this.state, mode: "input", transcript: this.cap([...this.state.transcript, { role: "user", text: next }]), queued: this.queue.length };
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
    /**
     * A blank line is not a task.
     *
     * Enter with an empty input queued an empty prompt — and while a job runs there is no consumer, so it
     * just incremented the counter, without limit. Pressing Enter while reading the agent panel ran the
     * count to seventeen; every one of them would have started a turn on "" once the job ended.
     */
    if (!task.trim()) return;
    if (this.taskResolve) {
      const resolve = this.taskResolve;
      this.taskResolve = undefined;
      // Hand the staged images to this turn; clear the staging area.
      this.turnAttachments = this.pendingAttachments;
      this.pendingAttachments = [];
      this.state = { ...this.state, transcript: this.cap([...this.state.transcript, { role: "user", text: task }]), attachments: 0 };
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

  /**
   * "By-the-way": a question asked while work is running.
   *
   * It used to be queued unconditionally with a note claiming it had been "folded into the running turn".
   * The inbox is only ever read by the COACH, which runs at the start and end of a job — so during a
   * multi-hour coding phase there was no turn to fold into, and the message promised an answer that would
   * not arrive until the whole job finished. The user watched two hours of output and never got a reply.
   *
   * `answerNow` is supplied when nothing is going to consume the note: the question is answered against the
   * live state instead of waiting for a turn that is not coming.
   */
  addInboxNote(text: string, answerNow?: (q: string) => void): void {
    /**
     * Folded in FIRST, answered separately only if nothing takes it.
     *
     * The previous version passed `answerNow` whenever a job was running — which is precisely when folding
     * in is possible — so the inbox was never used and every mid-run message came back as its own little
     * answer about a snapshot. What a person typing mid-run usually means is "while you are doing that:
     * also…", a correction to the work in hand, not a new question.
     *
     * Whether anything will consume it cannot be known from here: it depends which role is mid-turn. So it
     * is not guessed — the note is queued, and if no turn has taken it by the time the window closes, THEN
     * it is answered separately and the user is told which of the two happened. Being wrong slowly and
     * visibly beats being wrong instantly and silently.
     */
    this.inbox.push(text);
    this.note(`↳ folded into the running turn: ${text}`);
    if (!answerNow) return;
    const timer = setTimeout(() => {
      const at = this.inbox.indexOf(text);
      if (at < 0) return; // a turn took it — nothing to do
      this.inbox.splice(at, 1);
      this.note(`↳ nothing picked that up — the current step does not read mid-run notes, so answering it separately.`);
      answerNow(text);
    }, INBOX_FOLD_WINDOW_MS);
    timer.unref?.(); // never hold the process open for a note
  }

  /**
   * How long a mid-run note waits to be folded into a turn before it is answered on its own.
   *
   * Long enough to outlast a slow tool call — a single trace write has taken four minutes — and short
   * enough that a phase which will never read it does not swallow the message for the rest of the job.
   */
  /** What the running job looks like right now — the context a mid-run question is asked about. */
  liveSnapshot(): string {
    const s = this.state;
    const byColumn = new Map<string, number>();
    for (const c of s.cards) byColumn.set(c.column, (byColumn.get(c.column) ?? 0) + 1);
    const cols = [...byColumn.entries()].map(([k, n]) => `${k}: ${n}`).join(" · ") || "no board yet";
    const agents = s.runningAgents.length
      ? s.runningAgents.map((a) => `- ${a.title}${a.model ? ` (${a.model})` : ""}`).join("\n")
      : "- none";
    const recent = s.transcript.slice(-12)
      .map((m) => ("kind" in m ? `[${m.activity.tool}] ${m.activity.target}` : `${m.role}: ${m.text.slice(0, 120)}`))
      .join("\n");
    return `Phase: ${s.phase || "idle"}\nTasks — ${cols}\n\nRunning now:\n${agents}\n\nRecent activity:\n${recent}`;
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
    this.cancelled = false;   // …a new run may ask again
    this.agentStarts.clear();
    this.lastNarrated = undefined; // re-narrate phases for the new turn
    this.state = {
      ...this.state,
      mode: "running", cards: [], phase: "", detail: undefined, pending: undefined, runningAgents: [], nextSteps: [],
      meta: { model: "", promptTokens: 0, completionTokens: 0, cachedTokens: 0, calls: 0, startedAt: this.now(), running: true },
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
      meta: { model, promptTokens: 0, completionTokens: 0, cachedTokens: 0, calls: 0, startedAt: this.now(), running: true },
    };
    this.notify();
  }

  /** Leave the busy state → freezes the metrics into a done line ("…for Xs · ↑ ↓ · N calls"). */
  /**
   * Updates what the running indicator says, without disturbing the timer or the token counts.
   *
   * A phase set once and left alone is a shimmer that animates for two hours over the same three words. For
   * work that is thousands of independent items, the detail IS the signal that it is still moving.
   */
  busyDetail(detail: string): void {
    if (this.state.mode !== "running") return;
    this.state = { ...this.state, detail };
    this.notify();
  }

  endBusy(): void {
    const m = this.state.meta;
    const meta: TurnMeta | undefined = m
      ? { ...m, running: false, durationMs: m.startedAt !== undefined ? this.now() - m.startedAt : m.durationMs }
      : undefined;
    this.state = { ...this.state, mode: "input", meta };
    this.notify();
  }

  /**
   * Store the coach's suggested follow-ups AND put them in the conversation.
   *
   * They used to be drawn in a fixed strip BELOW the input, where they sat outside the transcript: they had
   * no place in the history, they were dropped whenever the frame ran short of rows, and they pushed the
   * input further from the last thing said. They are part of the assistant's answer — "here is what we could
   * do next" — so they belong in the chat, scrolling with everything else.
   *
   * The list is still kept in state, because `/next N` resolves against it.
   */
  setNextSteps(steps: string[]): void {
    const changed = steps.length > 0
      && (steps.length !== this.state.nextSteps.length || steps.some((s, i) => s !== this.state.nextSteps[i]));
    this.state = { ...this.state, nextSteps: steps };
    // Only a NEW set is announced: re-setting the same suggestions must not repeat them down the transcript.
    if (changed) {
      this.note(`**Suggested next steps** — \`/next N\` to run one:\n`
        + steps.map((s, i) => `${i + 1}. ${s}`).join("\n"));
    } else {
      this.notify();
    }
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
    this.state = { ...this.state, mode: "input", transcript: t, meta, runningAgents: [], liveActivity: undefined };
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

  /**
   * The mode to return to when a picker closes.
   *
   * A picker is an OVERLAY, not the end of the turn: `/mode auto`, `/model` or `/roles` can be used while a job
   * is running, and hard-resetting to "input" tore the status line off a job that was still working — the
   * shimmer never came back for the rest of the run.
   */
  private modeAfterPicker(): "input" | "running" {
    return this.state.meta?.running ? "running" : "input";
  }

  /** Applies a picked permission mode and confirms it in the transcript. */
  applyMode(mode: string, desc: string): void {
    this.state = {
      ...this.state,
      mode: this.modeAfterPicker(), picker: undefined,
      transcript: this.cap([...this.state.transcript, { role: "assistant", text: `Permission mode → **${mode}** — ${desc}.` }]),
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
    this.state = { ...this.state, mode: this.modeAfterPicker(), picker: undefined, currentModel: model };
    this.notify();
  }

  /** Applies a model chain to a single role (per-role) and confirms it in the transcript, inline. */
  applyRoleModel(role: string, models: string | string[]): void {
    const chain = typeof models === "string" ? [models] : models;
    const body = chain.length ? `${chain[0]}${chain.slice(1).map((m) => `  ↳ ${m}`).join("")}` : "—";
    this.state = {
      ...this.state,
      mode: this.modeAfterPicker(), picker: undefined,
      transcript: this.cap([...this.state.transcript, { role: "assistant", text: `\`${role}\` → ${body}` }]),
    };
    this.notify();
  }

  cancelPicker(): void {
    this.state = { ...this.state, mode: this.modeAfterPicker(), picker: undefined };
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
      if (idx < 0) { idx = this.state.transcript.length; this.state = { ...this.state, transcript: this.cap([...this.state.transcript, { role: "assistant", text: acc }]) }; } // create on first delta
      else { const t = [...this.state.transcript]; if (t[idx] && "role" in t[idx]) t[idx] = { role: "assistant", text: acc }; this.state = { ...this.state, transcript: t }; }
      this.notify();
    };
  }

  /**
   * A single assistant note that is REWRITTEN as it grows, rather than appended to.
   *
   * `streamNote` only ever appends, which is right for reasoning that arrives in order. An answer whose text
   * has to be cleaned as it streams — a model that emits its own thinking tags, say — needs the note to be
   * replaceable: the caller holds the raw text, decides what the reader should see, and hands over the whole
   * of it each time.
   *
   * Created lazily, so a call that never produces anything leaves no empty bubble.
   */
  liveNote(): (fullText: string) => void {
    let idx = -1;
    return (fullText: string): void => {
      if (!fullText) return;
      if (idx < 0) {
        idx = this.state.transcript.length;
        this.state = { ...this.state, transcript: this.cap([...this.state.transcript, { role: "assistant", text: fullText }]) };
      } else {
        const t = [...this.state.transcript];
        if (t[idx] && "role" in t[idx]) t[idx] = { role: "assistant", text: fullText };
        this.state = { ...this.state, transcript: t };
      }
      this.notify();
    };
  }

  /**
   * Records the command the user actually ran.
   *
   * A typed prompt appears in the transcript; a slash command did not, so scrolling back showed a note
   * — "Building the project code graph…" — with nothing above it saying what produced it. The record of
   * a session should say what was asked as well as what happened.
   */
  echoCommand(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.state = { ...this.state, transcript: this.cap([...this.state.transcript, { role: "user", text: t }]) };
    this.notify();
  }

  /** Append an assistant-style note to the transcript (used by /help). */
  note(text: string): void {
    this.state = { ...this.state, transcript: this.cap([...this.state.transcript, { role: "assistant", text }]) };
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
  /** The full conversation for persistence — never windowed, unlike the on-screen transcript. */
  messages(): { role: "user" | "assistant"; text: string }[] {
    return [
      ...this.archived,
      ...this.state.transcript.filter((m): m is { role: "user" | "assistant"; text: string } => !("kind" in m)),
    ];
  }
}

/** Returns a copy of the transcript with the last entry's text swapped to `text`, only if it's a user entry. */
function replaceLastUser(
  transcript: TuiState["transcript"],
  text: string,
): TuiState["transcript"] {
  const t = [...transcript];
  /**
   * The LAST user line, whatever has been printed since.
   *
   * It used to stop at the first assistant line on the way back, on the theory that one marks the previous
   * turn. It does not: a turn can print before the refined prompt arrives, and the commonest case is the
   * refiner itself falling to its next model — two notes ("… → gemini-3.5-flash-medium", "Benched …") land
   * between the prompt and the swap, the walk stops on them, and the raw prompt stays on screen. Measured on
   * a real session, which is how it was found: the user asked why their Turkish prompt had not been refined,
   * and it had been — the display simply never caught up.
   *
   * The last user line is always the current turn's prompt: a new turn appends one, so anything after it
   * belongs to that same turn.
   */
  for (let i = t.length - 1; i >= 0; i--) {
    const item = t[i];
    if ("kind" in item) continue; // tool activity → skip
    if (item.role === "user") { t[i] = { role: "user", text }; break; }
  }
  return t;
}
