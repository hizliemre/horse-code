import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskWithEscalation, tierOf } from "../../src/engine/escalation.js";
import type { EscalationDeps, AskHuman } from "../../src/engine/escalation.js";
import type { RoleConfig } from "../../src/config/config.js";
import { Board } from "../../src/board/board.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { ChatEvent } from "../../src/core/types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-esc-")); });
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
// Tek-turlu implementer (write yok — reviewer'a hızlı geçiş)
const noopImpl: ChatEvent[] = [{ type: "text-delta", text: "ok" }, { type: "done", finishReason: "stop" }];

interface EOpts { rounds?: number; askHuman?: AskHuman; signal?: AbortSignal }
function edeps(provider: MockProvider, opts: EOpts = {}): EscalationDeps {
  const roles: Record<string, RoleConfig> = {
    router: { models: ["m"], systemPrompt: "P-router" },
    coder: { models: ["m"], systemPrompt: "P-coder" },
    designer: { models: ["m"], systemPrompt: "P-designer" },
    "senior-coder": { models: ["m"], systemPrompt: "P-senior-coder" },
    "senior-designer": { models: ["m"], systemPrompt: "P-senior-designer" },
    architect: { models: ["m"], systemPrompt: "P-architect" },
    "code-reviewer": { models: ["m"], systemPrompt: "P-reviewer" },
  };
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: opts.signal ?? new AbortController().signal,
    rounds: opts.rounds ?? 3,
    askHuman: opts.askHuman ?? (async () => ({ action: "abandon" })),
  };
}
function boardWithTask(): Board {
  const b = new Board();
  b.addCard({ id: "t1", title: "X yap" });
  return b;
}
const contents = (p: MockProvider): string[] =>
  p.requests.flatMap((r) => r.messages.map((m) => (typeof m.content === "string" ? m.content : "")));

describe("tierOf", () => {
  it("attempts/rounds → tier", () => {
    expect(tierOf(0, 1)).toBe(0);
    expect(tierOf(1, 1)).toBe(1);
    expect(tierOf(2, 1)).toBe(2);
    expect(tierOf(0, 3)).toBe(0);
    expect(tierOf(2, 3)).toBe(0);
    expect(tierOf(3, 3)).toBe(1);
    expect(tierOf(5, 3)).toBe(1);
    expect(tierOf(6, 3)).toBe(2);
  });
});

describe("runTaskWithEscalation", () => {
  it("tier ilerlemesi (N=1): coder fail → senior-coder fail → konsey pass → DONE", async () => {
    const p = new MockProvider([
      submit('{"role":"coder"}'),                    // route → coder ailesi
      noopImpl, submit('{"verdict":"fail","notes":["a"]}'),   // tier0 coder fail
      noopImpl, submit('{"verdict":"fail","notes":["b"]}'),   // tier1 senior-coder fail
      submit('{"rootCause":"x","plan":["p"]}'),      // konsey: architect
      writeTurn(), doneTurn,                         // konsey: senior-coder implement
      submit('{"verdict":"pass","notes":[]}'),       // konsey: reviewer pass
    ]);
    const board = boardWithTask();
    const v = await runTaskWithEscalation(edeps(p, { rounds: 1 }), board, "t1", dir);
    expect(v.verdict).toBe("pass");
    expect(board.get("t1")!.column).toBe("DONE");
    expect(board.get("t1")!.attempts).toBe(2);
    // her tier doğru rolü kullandı
    const sys = p.requests.map((r) => r.messages[0].content);
    expect(sys).toContain("P-coder");
    expect(sys).toContain("P-senior-coder");
    expect(sys).toContain("P-architect");
  });

  it("designer ailesi (N=1): designer fail → senior-designer devralır", async () => {
    const p = new MockProvider([
      submit('{"role":"designer"}'),
      noopImpl, submit('{"verdict":"fail","notes":["a"]}'),   // tier0 designer fail
      noopImpl, submit('{"verdict":"pass","notes":[]}'),      // tier1 senior-designer pass
    ]);
    const board = boardWithTask();
    const v = await runTaskWithEscalation(edeps(p, { rounds: 1 }), board, "t1", dir);
    expect(v.verdict).toBe("pass");
    expect(board.get("t1")!.column).toBe("DONE");
    const sys = p.requests.map((r) => r.messages[0].content);
    expect(sys).toContain("P-designer");
    expect(sys).toContain("P-senior-designer");
  });

  it("konsey fail → askHuman accept → DONE (human:accept), verdict pass", async () => {
    let asked = 0;
    const askHuman: AskHuman = async () => { asked++; return { action: "accept" }; };
    const p = new MockProvider([
      submit('{"role":"coder"}'),
      noopImpl, submit('{"verdict":"fail","notes":["a"]}'),
      noopImpl, submit('{"verdict":"fail","notes":["b"]}'),
      submit('{"rootCause":"x","plan":["p"]}'), writeTurn(), doneTurn, submit('{"verdict":"fail","notes":["c"]}'),
    ]);
    const board = boardWithTask();
    const v = await runTaskWithEscalation(edeps(p, { rounds: 1, askHuman }), board, "t1", dir);
    expect(asked).toBe(1);
    expect(v.verdict).toBe("pass");
    expect(board.get("t1")!.column).toBe("DONE");
    expect(board.get("t1")!.stageHistory.map((s) => s.action)).toContain("human:accept");
  });

  it("konsey fail → askHuman retry → konsey tekrar; ikinci architect ipucunu görür", async () => {
    let asked = 0;
    const askHuman: AskHuman = async () => { asked++; return { action: "retry", notes: ["ipucu-XYZ"] }; };
    const p = new MockProvider([
      submit('{"role":"coder"}'),
      noopImpl, submit('{"verdict":"fail","notes":["a"]}'),
      noopImpl, submit('{"verdict":"fail","notes":["b"]}'),
      submit('{"rootCause":"x","plan":["p"]}'), writeTurn(), doneTurn, submit('{"verdict":"fail","notes":["c"]}'), // konsey1 fail
      submit('{"rootCause":"y","plan":["q"]}'), writeTurn(), doneTurn, submit('{"verdict":"pass","notes":[]}'),   // konsey2 pass
    ]);
    const board = boardWithTask();
    const v = await runTaskWithEscalation(edeps(p, { rounds: 1, askHuman }), board, "t1", dir);
    expect(asked).toBe(1);
    expect(v.verdict).toBe("pass");
    expect(board.get("t1")!.column).toBe("DONE");
    // retry sonrası ikinci konsey turunun architect mesajı ipucunu (reviewNotes) içerir
    expect(contents(p).some((c) => c.includes("ipucu-XYZ"))).toBe(true);
  });

  it("konsey fail → askHuman abandon → verdict fail, DONE'a taşınmaz (human:abandon)", async () => {
    const askHuman: AskHuman = async () => ({ action: "abandon" });
    const p = new MockProvider([
      submit('{"role":"coder"}'),
      noopImpl, submit('{"verdict":"fail","notes":["a"]}'),
      noopImpl, submit('{"verdict":"fail","notes":["b"]}'),
      submit('{"rootCause":"x","plan":["p"]}'), writeTurn(), doneTurn, submit('{"verdict":"fail","notes":["c"]}'),
    ]);
    const board = boardWithTask();
    const v = await runTaskWithEscalation(edeps(p, { rounds: 1, askHuman }), board, "t1", dir);
    expect(v.verdict).toBe("fail");
    expect(board.get("t1")!.column).not.toBe("DONE");
    expect(board.get("t1")!.stageHistory.map((s) => s.action)).toContain("human:abandon");
  });

  it("bilinmeyen task → hata", async () => {
    const p = new MockProvider([]);
    await expect(runTaskWithEscalation(edeps(p), boardWithTask(), "yok", dir)).rejects.toThrow(/bilinmeyen task/);
  });

  it("iptal edilmişse fırlatır (abort yutulmaz)", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new MockProvider([submit('{"role":"coder"}')]);
    await expect(
      runTaskWithEscalation(edeps(p, { signal: ac.signal }), boardWithTask(), "t1", dir),
    ).rejects.toThrow();
  });
});
