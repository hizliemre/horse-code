import type { AgentEvent, Tool, ToolCall, ToolResult } from "../core/types.js";
import type { PermissionEngine, PermissionRequest } from "../permission/engine.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface ToolExecResult {
  id: string;
  name: string;
  result: ToolResult;
}

export interface ToolExecDeps {
  tools: ToolRegistry;
  permission: PermissionEngine;
  approve: (req: PermissionRequest) => Promise<boolean>;
  cwd: string;
  signal: AbortSignal;
}

interface Plan {
  index: number;
  call: ToolCall;
  kind: "run" | "ask" | "error" | "deny";
  tool?: Tool;
  args?: Record<string, unknown>;
  req?: PermissionRequest;
  errorContent?: string;
}

function errResult(name: string, msg: string): ToolResult {
  return { content: `${name}: ${msg}`, isError: true };
}

/**
 * Tool-call'ları permission ile süzüp çalıştırır. allow'lar paralel, ask'ler sıralı.
 * AgentEvent yayar; sonuçları ÇAĞRI SIRASINDA döner (her call için bir result).
 */
export async function* executeToolCalls(
  calls: ToolCall[],
  deps: ToolExecDeps,
): AsyncGenerator<AgentEvent, ToolExecResult[], void> {
  const results: ToolExecResult[] = new Array(calls.length);
  const plans: Plan[] = [];

  // 1) Sınıflandır
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (!call.id) {
      plans.push({ index: i, call, kind: "error", errorContent: "geçersiz tool-call id" });
      continue;
    }
    const tool = deps.tools.get(call.name);
    if (!tool) {
      plans.push({ index: i, call, kind: "error", errorContent: `bilinmeyen tool: ${call.name}` });
      continue;
    }
    let args: Record<string, unknown>;
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      plans.push({ index: i, call, kind: "error", errorContent: "argümanlar geçersiz JSON" });
      continue;
    }
    if (tool.permissionLevel === "safe") {
      plans.push({ index: i, call, kind: "run", tool, args });
      continue;
    }
    let desc: { allowKey: string; preview: string };
    try {
      desc = tool.describe ? tool.describe(args) : { allowKey: call.name, preview: call.name };
    } catch (e) {
      plans.push({
        index: i, call, kind: "error",
        errorContent: `describe hatası: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    const req: PermissionRequest = { level: tool.permissionLevel, preview: desc.preview, allowKey: desc.allowKey };
    const decision = deps.permission.check(req);
    plans.push({ index: i, call, kind: decision === "allow" ? "run" : decision === "ask" ? "ask" : "deny", tool, args, req });
  }

  // 2) error / deny → anında result
  for (const p of plans) {
    if (p.kind === "error" || p.kind === "deny") {
      const result = p.kind === "error"
        ? errResult(p.call.name, p.errorContent!)
        : errResult(p.call.name, "kullanıcı reddetti");
      yield { type: "tool.request", toolCall: p.call };
      results[p.index] = { id: p.call.id, name: p.call.name, result };
      yield { type: "tool.result", toolCallId: p.call.id, result };
    }
  }

  // 3) auto (allow) → paralel
  const autoPlans = plans.filter((p) => p.kind === "run");
  for (const p of autoPlans) yield { type: "tool.request", toolCall: p.call };
  const autoResults = await Promise.all(
    autoPlans.map((p) => p.tool!.run(p.args!, { cwd: deps.cwd, signal: deps.signal })),
  );
  for (let k = 0; k < autoPlans.length; k++) {
    const p = autoPlans[k];
    results[p.index] = { id: p.call.id, name: p.call.name, result: autoResults[k] };
    yield { type: "tool.result", toolCallId: p.call.id, result: autoResults[k] };
  }

  // 4) gated (ask) → sıralı
  for (const p of plans.filter((pp) => pp.kind === "ask")) {
    yield { type: "tool.request", toolCall: p.call };
    yield {
      type: "permission.ask",
      requestId: p.call.id,
      toolName: p.call.name,
      permissionLevel: p.tool!.permissionLevel,
      preview: p.req!.preview,
    };
    const ok = await deps.approve(p.req!);
    const result = ok
      ? await p.tool!.run(p.args!, { cwd: deps.cwd, signal: deps.signal })
      : errResult(p.call.name, "kullanıcı reddetti");
    results[p.index] = { id: p.call.id, name: p.call.name, result };
    yield { type: "tool.result", toolCallId: p.call.id, result };
  }

  return results;
}
