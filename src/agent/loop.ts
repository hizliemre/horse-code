import type {
  AgentEvent, ChatRequest, Message, Provider, ToolCall,
} from "../core/types.js";
import type { PermissionEngine, PermissionRequest } from "../permission/engine.js";
import type { ToolRegistry } from "../tools/registry.js";
import { executeToolCalls } from "./tool-exec.js";
import { shieldToolOutput } from "../core/prompt-guard.js";

export interface RoleAgentOptions {
  provider: Provider;
  model: string;
  fallbacks?: string[]; // ordered fallback models: on a retryable error before any output, drop to the next
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
  onExhausted?: (model: string) => void; // a model hit a retryable error → mark it spent for the session
  onFallback?: (from: string, to: string, reason: string) => void; // fell from one model to the next → UI note
}

export async function* runRoleAgent(opts: RoleAgentOptions): AsyncGenerator<AgentEvent, void, void> {
  const working: Message[] = [{ role: "system", content: opts.systemPrompt }, ...opts.messages];
  const schemas = opts.tools.schemas();
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
      let errored: { message: string; retryable?: boolean } | undefined;
      // messages: snapshot (copy) each turn — so the provider doesn't hold a reference to our internal array
      const req: ChatRequest = { model: activeModel, messages: [...working], tools: schemas };

      for await (const ev of opts.provider.chat(req, opts.signal)) {
        if (ev.type === "text-delta") {
          assistantText += ev.text;
          streamed = true;
          yield { type: "message.delta", text: ev.text };
        } else if (ev.type === "tool-call") {
          toolCalls.push(ev.toolCall);
        } else if (ev.type === "usage") {
          yield { type: "usage", promptTokens: ev.promptTokens, completionTokens: ev.completionTokens };
        } else if (ev.type === "error") {
          errored = { message: ev.message, retryable: ev.retryable };
          break;
        }
        // "done" → ignore; the loop decides based on toolCalls
      }

      if (!errored) break; // turn produced a (possibly tool-calling) response → proceed
      if (errored.retryable) opts.onExhausted?.(activeModel); // spent for the session either way
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

    if (toolCalls.length === 0) return;

    const results = yield* executeToolCalls(toolCalls, {
      tools: opts.tools,
      permission: opts.permission,
      approve: opts.approve,
      cwd: opts.cwd,
      signal: opts.signal,
      onActivity: opts.onActivity,
      remember: opts.remember,
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
