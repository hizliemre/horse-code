import type {
  AgentEvent, ChatRequest, Message, Provider, ToolCall,
} from "../core/types.js";
import type { PermissionEngine, PermissionRequest } from "../permission/engine.js";
import type { ToolRegistry } from "../tools/registry.js";
import { executeToolCalls } from "./tool-exec.js";

export interface RoleAgentOptions {
  provider: Provider;
  model: string;
  systemPrompt: string;
  tools: ToolRegistry;
  messages: Message[];
  permission: PermissionEngine;
  approve: (req: PermissionRequest) => Promise<boolean>;
  cwd: string;
  signal: AbortSignal;
  maxTurns?: number;
}

export async function* runRoleAgent(opts: RoleAgentOptions): AsyncGenerator<AgentEvent, void, void> {
  const working: Message[] = [{ role: "system", content: opts.systemPrompt }, ...opts.messages];
  const schemas = opts.tools.schemas();
  const maxTurns = opts.maxTurns ?? 50;
  let turn = 0;

  while (true) {
    if (opts.signal.aborted) {
      yield { type: "abort" };
      return;
    }
    if (turn >= maxTurns) {
      yield { type: "error", message: `maximum turn count exceeded (${maxTurns})` };
      return;
    }
    turn++;

    let assistantText = "";
    const toolCalls: ToolCall[] = [];
    let errored = false;
    // messages: snapshot (copy) each turn — so the provider doesn't hold a reference to our internal array
    const req: ChatRequest = { model: opts.model, messages: [...working], tools: schemas };

    for await (const ev of opts.provider.chat(req, opts.signal)) {
      if (ev.type === "text-delta") {
        assistantText += ev.text;
        yield { type: "message.delta", text: ev.text };
      } else if (ev.type === "tool-call") {
        toolCalls.push(ev.toolCall);
      } else if (ev.type === "usage") {
        yield { type: "usage", promptTokens: ev.promptTokens, completionTokens: ev.completionTokens };
      } else if (ev.type === "error") {
        yield { type: "error", message: ev.message };
        errored = true;
        break;
      }
      // "done" → ignore; the loop decides based on toolCalls
    }
    if (errored) return;

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
    });
    for (const r of results) {
      working.push({ role: "tool", toolCallId: r.id, name: r.name, content: r.result.content });
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
