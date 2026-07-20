import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runConflictCouncil } from "../../src/engine/conflict.js";
import type { ConflictDeps } from "../../src/engine/conflict.js";
import type { AskHuman } from "../../src/engine/escalation.js";
import { createMergeConflict } from "../worktree/helpers.js";
import type { RoleConfig } from "../../src/config/config.js";
import { Board } from "../../src/board/board.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { ChatEvent } from "../../src/core/types.js";

let repo: string;
afterEach(async () => { if (repo) await rm(repo, { recursive: true, force: true }); });

function submit(argsJson: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: argsJson } },
    { type: "done", finishReason: "tool_calls" },
  ];
}
function writeTurn(path: string, content: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "w", name: "write_file", arguments: JSON.stringify({ path, content }) } },
    { type: "done", finishReason: "tool_calls" },
  ];
}
const doneTurn: ChatEvent[] = [{ type: "text-delta", text: "ok" }, { type: "done", finishReason: "stop" }];

interface COpts { rounds?: number; askHuman?: AskHuman; signal?: AbortSignal }
function cdeps(provider: MockProvider, manager: ConflictDeps["manager"], opts: COpts = {}): ConflictDeps {
  const roles: Record<string, RoleConfig> = {
    architect: { models: ["m"], systemPrompt: "P-architect" },
    "senior-coder": { models: ["m"], systemPrompt: "P-senior-coder" },
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
    manager,
  };
}
const hasContent = (p: MockProvider, needle: string): boolean =>
  p.requests.some((r) => r.messages.some((m) => typeof m.content === "string" && m.content.includes(needle)));

describe("runConflictCouncil", () => {
  it("resolved: architect → resolver(marker'sız) → reviewer pass → commitMerge", async () => {
    const c = await createMergeConflict(); repo = c.repo;
    const board = new Board(); board.addCard({ id: "t1", title: "shared" });
    const p = new MockProvider([
      submit('{"rootCause":"iki taraf shared.txt değişti","plan":["birleştir"]}'),
      writeTurn("shared.txt", "MERGED\n"), doneTurn,
      submit('{"verdict":"pass","notes":[]}'),
    ]);
    const res = await runConflictCouncil(cdeps(p, c.mgr), c.session, board, "t1", c.task);
    expect(res.status).toBe("resolved");
    expect(await c.mgr.unmergedFiles(c.session)).toEqual([]);
    expect(await readFile(join(c.session.baseWorktree, "shared.txt"), "utf8")).toBe("MERGED\n");
    const actions = board.get("t1")!.stageHistory.map((s) => s.action);
    expect(actions).toContain("conflict:diagnosed");
    expect(actions).toContain("conflict:merged");
  });

  it("marker kalırsa fail → retry; ikinci attempt marker'sız → resolved", async () => {
    const c = await createMergeConflict(); repo = c.repo;
    const board = new Board(); board.addCard({ id: "t1", title: "shared" });
    const p = new MockProvider([
      submit('{"rootCause":"x","plan":["y"]}'),
      writeTurn("shared.txt", "<<<<<<< HEAD\nAAA\n=======\nBBB\n>>>>>>>\n"), doneTurn,
      submit('{"rootCause":"x2","plan":["y2"]}'),
      writeTurn("shared.txt", "MERGED\n"), doneTurn,
      submit('{"verdict":"pass","notes":[]}'),
    ]);
    const res = await runConflictCouncil(cdeps(p, c.mgr, { rounds: 2 }), c.session, board, "t1", c.task);
    expect(res.status).toBe("resolved");
    expect(await readFile(join(c.session.baseWorktree, "shared.txt"), "utf8")).toBe("MERGED\n");
  });

  it("reviewer fail → retry; ipucu ikinci architect'e taşınır → resolved", async () => {
    const c = await createMergeConflict(); repo = c.repo;
    const board = new Board(); board.addCard({ id: "t1", title: "shared" });
    const p = new MockProvider([
      submit('{"rootCause":"x","plan":["y"]}'),
      writeTurn("shared.txt", "M1\n"), doneTurn,
      submit('{"verdict":"fail","notes":["yanlış-birleşim-ABC"]}'),
      submit('{"rootCause":"x2","plan":["y2"]}'),
      writeTurn("shared.txt", "M2\n"), doneTurn,
      submit('{"verdict":"pass","notes":[]}'),
    ]);
    const res = await runConflictCouncil(cdeps(p, c.mgr, { rounds: 2 }), c.session, board, "t1", c.task);
    expect(res.status).toBe("resolved");
    expect(await readFile(join(c.session.baseWorktree, "shared.txt"), "utf8")).toBe("M2\n");
    expect(hasContent(p, "yanlış-birleşim-ABC")).toBe(true);
  });

  it("N tükendi → askHuman abandon → abortMerge → {unresolved}", async () => {
    const c = await createMergeConflict(); repo = c.repo;
    const board = new Board(); board.addCard({ id: "t1", title: "shared" });
    const askHuman: AskHuman = async () => ({ action: "abandon" });
    const p = new MockProvider([
      submit('{"rootCause":"x","plan":["y"]}'),
      writeTurn("shared.txt", "<<<<<<< kal\n"), doneTurn,
    ]);
    const res = await runConflictCouncil(cdeps(p, c.mgr, { rounds: 1, askHuman }), c.session, board, "t1", c.task);
    expect(res.status).toBe("unresolved");
    expect(await c.mgr.unmergedFiles(c.session)).toEqual([]); // abortMerge → merge öncesine döndü
    expect(board.get("t1")!.stageHistory.map((s) => s.action)).toContain("conflict:aborted");
  });

  it("N tükendi → askHuman retry(ipucu) → ikinci tur resolved; ipucu architect'e taşınır", async () => {
    const c = await createMergeConflict(); repo = c.repo;
    const board = new Board(); board.addCard({ id: "t1", title: "shared" });
    let asked = 0;
    const askHuman: AskHuman = async () => { asked++; return { action: "retry", notes: ["insan-ipucu-XYZ"] }; };
    const p = new MockProvider([
      submit('{"rootCause":"x","plan":["y"]}'),
      writeTurn("shared.txt", "<<<<<<< kal\n"), doneTurn,
      submit('{"rootCause":"x2","plan":["y2"]}'),
      writeTurn("shared.txt", "MERGED\n"), doneTurn,
      submit('{"verdict":"pass","notes":[]}'),
    ]);
    const res = await runConflictCouncil(cdeps(p, c.mgr, { rounds: 1, askHuman }), c.session, board, "t1", c.task);
    expect(res.status).toBe("resolved");
    expect(asked).toBe(1);
    expect(hasContent(p, "insan-ipucu-XYZ")).toBe(true);
  });

  it("pre-aborted signal → fırlatır (yutulmaz)", async () => {
    const c = await createMergeConflict(); repo = c.repo;
    const ac = new AbortController(); ac.abort();
    const board = new Board(); board.addCard({ id: "t1", title: "shared" });
    const p = new MockProvider([submit('{"rootCause":"x","plan":["y"]}')]);
    await expect(
      runConflictCouncil(cdeps(p, c.mgr, { signal: ac.signal }), c.session, board, "t1", c.task),
    ).rejects.toThrow();
  });

  it("bilinmeyen task → hata", async () => {
    const c = await createMergeConflict(); repo = c.repo;
    const p = new MockProvider([]);
    await expect(
      runConflictCouncil(cdeps(p, c.mgr), c.session, new Board(), "yok", c.task),
    ).rejects.toThrow(/bilinmeyen task/);
  });
});
