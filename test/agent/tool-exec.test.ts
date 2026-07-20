import { describe, it, expect } from "vitest";
import { z } from "zod";
import { executeToolCalls, type ToolExecResult } from "../../src/agent/tool-exec.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { AgentEvent, Tool, ToolCall } from "../../src/core/types.js";

// Basit sahte tool'lar
const safeEcho: Tool = {
  name: "echo",
  description: "girdiyi döner",
  permissionLevel: "safe",
  parameters: z.object({ t: z.string() }),
  run: async (a) => ({ content: `echo:${a.t}`, isError: false }),
};
const writeTool: Tool = {
  name: "w",
  description: "yazar",
  permissionLevel: "write",
  parameters: z.object({ p: z.string() }),
  describe: (a) => ({ allowKey: String(a.p), preview: `write ${a.p}` }),
  run: async (a) => ({ content: `wrote:${a.p}`, isError: false }),
};
const throwsDescribe: Tool = {
  name: "bad",
  description: "describe throw",
  permissionLevel: "write",
  parameters: z.object({ p: z.string() }),
  describe: () => { throw new Error("describe patladı"); },
  run: async () => ({ content: "x", isError: false }),
};

function registry(...tools: Tool[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of tools) r.register(t);
  return r;
}
function call(id: string, name: string, args: object): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}
async function drainGen(
  gen: AsyncGenerator<AgentEvent, ToolExecResult[], void>,
): Promise<{ events: AgentEvent[]; result: ToolExecResult[] }> {
  const events: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) { events.push(r.value); r = await gen.next(); }
  return { events, result: r.value };
}
const deps = (over: Partial<Parameters<typeof executeToolCalls>[1]>) => ({
  tools: registry(safeEcho, writeTool, throwsDescribe),
  permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
  approve: async () => true,
  cwd: "/tmp",
  signal: new AbortController().signal,
  ...over,
});

describe("executeToolCalls", () => {
  it("safe tool otomatik çalışır, sonuç çağrı sırasında döner", async () => {
    const { result } = await drainGen(executeToolCalls([call("1", "echo", { t: "hi" })], deps({})));
    expect(result).toEqual([{ id: "1", name: "echo", result: { content: "echo:hi", isError: false } }]);
  });

  it("auto modda write tool çalışır", async () => {
    const { result } = await drainGen(executeToolCalls([call("1", "w", { p: "a.ts" })], deps({})));
    expect(result[0].result).toEqual({ content: "wrote:a.ts", isError: false });
  });

  it("ask modda approve=false ise reddedilir (çalıştırılmaz)", async () => {
    const { events, result } = await drainGen(
      executeToolCalls([call("1", "w", { p: "a.ts" })], deps({
        permission: new PermissionEngine({ mode: "ask", allowlist: [] }),
        approve: async () => false,
      })),
    );
    expect(result[0].result.isError).toBe(true);
    expect(result[0].result.content).toContain("reddetti");
    expect(events.some((e) => e.type === "permission.ask")).toBe(true);
  });

  it("ask modda approve=true ise çalışır", async () => {
    const { result } = await drainGen(
      executeToolCalls([call("1", "w", { p: "a.ts" })], deps({
        permission: new PermissionEngine({ mode: "ask", allowlist: [] }),
        approve: async () => true,
      })),
    );
    expect(result[0].result).toEqual({ content: "wrote:a.ts", isError: false });
  });

  it("bilinmeyen tool → hata result", async () => {
    const { result } = await drainGen(executeToolCalls([call("1", "yok", {})], deps({})));
    expect(result[0].result.isError).toBe(true);
    expect(result[0].result.content).toContain("bilinmeyen tool");
  });

  it("boş tool-call id → hata result (çalıştırılmaz)", async () => {
    const { result } = await drainGen(executeToolCalls([call("", "echo", { t: "x" })], deps({})));
    expect(result[0].result.isError).toBe(true);
    expect(result[0].result.content).toContain("geçersiz tool-call id");
  });

  it("describe throw → hata result (çalıştırılmaz)", async () => {
    const { result } = await drainGen(executeToolCalls([call("1", "bad", { p: "a" })], deps({})));
    expect(result[0].result.isError).toBe(true);
    expect(result[0].result.content).toContain("describe");
  });

  it("çoklu safe tool paralel çalışır, sonuç çağrı sırasında", async () => {
    const { result } = await drainGen(
      executeToolCalls([call("1", "echo", { t: "a" }), call("2", "echo", { t: "b" })], deps({})),
    );
    expect(result.map((r) => r.result.content)).toEqual(["echo:a", "echo:b"]);
  });
});
