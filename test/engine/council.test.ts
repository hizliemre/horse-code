import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEscalationCouncil } from "../../src/engine/council.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";
import type { RoleConfig } from "../../src/config/config.js";
import { Board } from "../../src/board/board.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { ChatEvent } from "../../src/core/types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-council-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function submit(argsJson: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: argsJson } },
    { type: "done", finishReason: "tool_calls" },
  ];
}
function writeTurn(): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "w", name: "write_file", arguments: '{"path":"out.txt","content":"kod"}' } },
    { type: "done", finishReason: "tool_calls" },
  ];
}
const doneTurn: ChatEvent[] = [{ type: "text-delta", text: "bitti" }, { type: "done", finishReason: "stop" }];

function deps(provider: MockProvider): TaskCycleDeps {
  const roles: Record<string, RoleConfig> = {
    architect: { models: ["m"], systemPrompt: "P-architect" },
    "senior-coder": { models: ["m"], systemPrompt: "P-senior-coder" },
    "senior-designer": { models: ["m"], systemPrompt: "P-senior-designer" },
    "code-reviewer": { models: ["m"], systemPrompt: "P-reviewer" },
  };
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: new AbortController().signal,
  };
}
function boardWithTask(): Board {
  const b = new Board();
  b.addCard({ id: "t1", title: "X yap" });
  return b;
}

describe("runEscalationCouncil", () => {
  it("pass: architect diagnoz → senior implement → reviewer pass; stage kayıtları + senior plan görür", async () => {
    // architect submit → senior write → senior done → reviewer pass
    const p = new MockProvider([
      submit('{"rootCause":"eksik test","plan":["testi ekle","kodu düzelt"]}'),
      writeTurn(), doneTurn,
      submit('{"verdict":"pass","notes":[]}'),
    ]);
    const board = boardWithTask();
    const v = await runEscalationCouncil(deps(p), board, "t1", dir, "coder");
    expect(v.verdict).toBe("pass");
    const c = board.get("t1")!;
    const actions = c.stageHistory.map((s) => s.action);
    expect(actions).toContain("council:diagnosed");
    expect(actions).toContain("council:implemented");
    expect(actions).toContain("reviewed:pass");
    // senior implement (requests[1]) architect planını (reviewNotes) mesajında gördü
    expect(p.requests[1].messages[0].content).toBe("P-senior-coder");
    expect(p.requests[1].messages.some((m) => typeof m.content === "string" && m.content.includes("testi ekle"))).toBe(true);
    expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("kod");
  });

  it("fail: reviewer fail → Verdict fail döner, DONE'a taşınmaz (REVIEW'da kalır)", async () => {
    const p = new MockProvider([
      submit('{"rootCause":"x","plan":["y"]}'),
      writeTurn(), doneTurn,
      submit('{"verdict":"fail","notes":["hâlâ hata"]}'),
    ]);
    const board = boardWithTask();
    const v = await runEscalationCouncil(deps(p), board, "t1", dir, "coder");
    expect(v.verdict).toBe("fail");
    expect(v.notes).toEqual(["hâlâ hata"]);
    expect(board.get("t1")!.column).toBe("REVIEW");
    expect(board.get("t1")!.stageHistory.map((s) => s.action)).toContain("reviewed:fail");
  });

  it("designer ailesi: senior-designer implement eder", async () => {
    const p = new MockProvider([
      submit('{"rootCause":"x","plan":["y"]}'),
      writeTurn(), doneTurn,
      submit('{"verdict":"pass","notes":[]}'),
    ]);
    const board = boardWithTask();
    await runEscalationCouncil(deps(p), board, "t1", dir, "designer");
    expect(p.requests[1].messages[0].content).toBe("P-senior-designer");
  });
});
