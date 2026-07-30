import type {
  AgentEvent, ChatRequest, Message, Provider, ToolCall,
} from "../core/types.js";
import type { PermissionEngine, PermissionRequest } from "../permission/engine.js";
import type { ToolRegistry } from "../tools/registry.js";
import { executeToolCalls } from "./tool-exec.js";
import { shieldToolOutput } from "../core/prompt-guard.js";
import { elideInPlace } from "./elide.js";

export interface RoleAgentOptions {
  provider: Provider;
  model: string;
  fallbacks?: string[]; // ordered fallback models: on a retryable error before any output, drop to the next
  /**
   * A deadline for EACH model attempt, rather than one for the whole chain.
   *
   * One deadline for the whole call is worse than none: a first model that hangs eats the entire budget and
   * every fallback then sees an already-aborted signal. Honoured by runStructuredRole, which owns the chain
   * walk; a per-model clock is also the honest reading of "this model did not answer in time".
   */
  perAttemptMs?: number;
  /**
   * A ceiling on the WHOLE chain walk, as distinct from one model's turn at it.
   *
   * Per-model clocks fixed one bug and created another: with three models and two attempts each, a
   * three-minute deadline means eighteen minutes before the chain gives up. Measured live — a task sat at
   * DONE for a quarter of an hour while its one-sentence commit message walked the chain, with nothing
   * hung and nothing to see. Both bounds are needed: per-attempt so one slow model cannot end the chain,
   * total so the chain cannot outlast the thing it is for.
   */
  totalMs?: number;
  systemPrompt: string;
  tools: ToolRegistry;
  messages: Message[];
  permission: PermissionEngine;
  approve: (req: PermissionRequest) => Promise<boolean>;
  cwd: string;
  signal: AbortSignal;
  maxTurns?: number;
  onActivity?: (a: import("../core/types.js").ToolActivity) => void; // live file-write/edit activity → UI
  inbox?: () => string | undefined; // polled each turn → a "by-the-way" note is folded in as a user message
  remember?: (fact: string) => void; // remember_fact tool → persist a durable fact
  proposeMemory?: (text: string, kind: "fact" | "lesson") => boolean; // propose_memory tool → curator queue
  onExhausted?: (model: string, reason?: string) => void; // a model hit a retryable error → mark it spent
  onStructuralFailure?: (model: string, reason?: string) => void; // model answered in prose → strike against it
  onFallback?: (from: string, to: string, reason: string) => void; // fell from one model to the next → UI note
  onLiveActivity?: (label: string) => void; // live "writing <file> · N chars" while a tool call is generated
  onWrite?: (path: string) => Promise<void>; // after each successful write/edit → per-file auto-commit
  onUsage?: (u: { promptTokens: number; completionTokens: number; model: string }) => void; // per-call usage + the model that served it
}

/** 1394 → "1.4k"; keeps the live activity line compact. */
function fmtChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k chars` : `${n} chars`;
}

export async function* runRoleAgent(opts: RoleAgentOptions): AsyncGenerator<AgentEvent, void, void> {
  const working: Message[] = [{ role: "system", content: opts.systemPrompt }, ...opts.messages];
  const schemas = opts.tools.schemas();
  // The blind-overwrite guard is only wired for agents whose writes are NOT individually committed.
  //
  // Its premise is that an overwrite destroys content irrecoverably. That is true for the merge-conflict
  // resolver, which edits a shared worktree mid-merge. It is NOT true for the implementer or the spec-kit
  // phases: every write of theirs is committed as it happens (`onWrite`), so git holds every version and a
  // bad overwrite is recoverable. Guarding them anyway had a real cost — a RETURNING task must rewrite files
  // it wrote in an earlier attempt, and a fresh run has no record of reading them, so every write was refused
  // and the attempt produced nothing at all.
  const readFiles = opts.onWrite ? undefined : new Set<string>();
  const maxTurns = opts.maxTurns ?? 50;
  let turn = 0;

  // Strict-priority fallback chain: primary first, then each fallback. `chainIdx` only ever advances (on a
  // retryable error before output) — once we drop to a fallback we stay there for the rest of the run.
  const chain = [opts.model, ...(opts.fallbacks ?? [])];
  let chainIdx = 0;

  while (true) {
    if (opts.signal.aborted) {
      yield { type: "abort" };
      return;
    }
    if (turn >= maxTurns) {
      yield { type: "error", message: `maximum turn count exceeded (${maxTurns})` };
      return;
    }
    // "By-the-way" injection: fold any queued note in as a user message before this turn's request.
    // Safe here — the previous turn's tool results are already appended, so a user message is well-ordered.
    for (let note = opts.inbox?.(); note !== undefined; note = opts.inbox?.()) {
      working.push({ role: "user", content: note });
    }
    turn++;

    let assistantText = "";
    let toolCalls: ToolCall[] = [];
    let fatal: { message: string; retryable?: boolean } | undefined;

    // Attempt the turn with the active model; on a retryable error BEFORE any text streamed, mark the model
    // exhausted and retry the same turn with the next chain model. A partial (streamed) response can't be
    // cleanly retried, so it surfaces as a normal error.
    for (;;) {
      const activeModel = chain[chainIdx];
      assistantText = "";
      toolCalls = [];
      let streamed = false;
      let errored: { message: string; retryable?: boolean; capability?: boolean; noBench?: boolean } | undefined;
      // messages: snapshot (copy) each turn — so the provider doesn't hold a reference to our internal array.
      // Older large tool outputs are elided on the way out: with no prompt-cache control every turn re-bills
      // the whole conversation, and a file read from thirty turns ago is the single biggest thing being paid
      // for repeatedly. Our own `working` history stays complete.
      // Elided IN PLACE: the history is never read at full size again, and keeping it was what put a
      // long run into the heap ceiling. The provider still gets a COPY — it must never hold a reference to
      // an array that is still growing.
      elideInPlace(working);
      const req: ChatRequest = { model: activeModel, messages: [...working], tools: schemas };

      for await (const ev of opts.provider.chat(req, opts.signal)) {
        if (ev.type === "text-delta") {
          assistantText += ev.text;
          streamed = true;
          yield { type: "message.delta", text: ev.text };
        } else if (ev.type === "tool-call") {
          toolCalls.push(ev.toolCall);
        } else if (ev.type === "tool-progress") {
          // Model is still generating this tool call's args → surface live progress for a FILE WRITE, where
          // the wait is long enough to need feedback. A read or a search generates its tiny argument in
          // milliseconds, so a line for it only flashed — and every flash resized the status box, which is
          // what made the progress indicator itself appear to stutter. Those tools now report into the chat
          // once they have actually run, which is the record worth keeping anyway.
          if (ev.path) opts.onLiveActivity?.(`writing ${ev.path.split("/").pop()} · ${fmtChars(ev.chars)}`);
        } else if (ev.type === "usage") {
          yield { type: "usage", promptTokens: ev.promptTokens, completionTokens: ev.completionTokens };
          opts.onUsage?.({ promptTokens: ev.promptTokens, completionTokens: ev.completionTokens, model: activeModel });
        } else if (ev.type === "error") {
          errored = { message: ev.message, retryable: ev.retryable, capability: ev.capability, noBench: ev.noBench };
          break;
        }
        // "done" → ignore; the loop decides based on toolCalls
      }

      if (!errored) break; // turn produced a (possibly tool-calling) response → proceed
      /**
       * A cancelled run never benches a model.
       *
       * Checked here as well as in the provider because this is the layer that owns the signal: whatever a
       * provider reports, a model cannot have failed during a turn the user stopped. Getting this wrong told
       * the user their model had died and re-assigned every role that used it — for pressing Ctrl+C.
       */
      if (opts.signal.aborted) {
        /**
         * A DEADLINE of ours is not a cancellation, and this is the layer that has to tell them apart.
         *
         * Since each model attempt is given its own clock, the signal this loop owns fires for two very
         * different reasons: a person stopping the run, and one model taking too long. Reporting both as
         * "cancelled — not retryable" made the per-attempt clock useless: the first slow model ended the
         * whole chain walk. Measured on a real run — six models reporting a deadline in the same second, over
         * and over, and not one review finishing in four hours.
         */
        const byDeadline = (opts.signal.reason as { name?: string } | undefined)?.name === "TimeoutError";
        fatal = byDeadline
          ? { message: "the model did not answer within its deadline", retryable: true }
          : { message: "cancelled", retryable: false };
        break;
      }
      /**
       * A capability refusal falls back without benching.
       *
       * "The long context beta is not yet available for this subscription" says this REQUEST does not fit
       * this model, not that the model is unwell. Quarantining it took a perfectly usable model out of the
       * pool for every later request too — including all the ones small enough for it.
       */
      // A refusal, or a fault that is not about this model at all, moves on WITHOUT taking it out of service.
      if (errored.retryable && !errored.capability && !errored.noBench) opts.onExhausted?.(activeModel, errored.message);
      if (errored.retryable && !streamed && chainIdx < chain.length - 1) {
        const next = chain[chainIdx + 1];
        opts.onFallback?.(activeModel, next, errored.message);
        chainIdx++;
        continue; // retry the same turn with the next model
      }
      fatal = errored; // no fallback left (or already streaming) → surface it
      break;
    }
    if (fatal) {
      yield { type: "error", message: fatal.message, retryable: fatal.retryable };
      return;
    }

    const assistantMsg: Message = {
      role: "assistant",
      content: assistantText,
      ...(toolCalls.length ? { toolCalls } : {}),
    };
    working.push(assistantMsg);
    yield { type: "message.done", message: assistantMsg };
    // Generation of this turn (incl. any tool-call args) is done → clear the transient "writing/grep · N chars"
    // line so a read-only tool (grep/read/glob), which never pushes file activity, doesn't leave it stuck.
    opts.onLiveActivity?.("");

    if (toolCalls.length === 0) return;

    const results = yield* executeToolCalls(toolCalls, {
      tools: opts.tools,
      permission: opts.permission,
      approve: opts.approve,
      cwd: opts.cwd,
      signal: opts.signal,
      onActivity: opts.onActivity,
      remember: opts.remember,
      proposeMemory: opts.proposeMemory,
      readFiles,
      onWrite: opts.onWrite,
    });
    for (const r of results) {
      // Ingress defense: fence tool output that looks like a prompt-injection attempt before the model sees it.
      working.push({ role: "tool", toolCallId: r.id, name: r.name, content: shieldToolOutput(r.result.content) });
    }
    // loop goes back to the top → LLM sees the tool results
  }
}

export async function runToCompletion(opts: RoleAgentOptions): Promise<Message> {
  let last: Message | undefined;
  for await (const ev of runRoleAgent(opts)) {
    if (ev.type === "message.done") last = ev.message;
    else if (ev.type === "error") throw new Error(ev.message);
    else if (ev.type === "abort") throw new Error("cancelled");
  }
  if (!last) throw new Error("runToCompletion: no message was produced");
  return last;
}
