import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveMergeConflict } from "../../src/engine/conflict.js";
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
import { reviewBodies } from "../support/review-bodies.js";
import { fakeSpecKit } from "../support/fake-speckit.js";

let repo: string;
afterEach(async () => { if (repo) await rm(repo, { recursive: true, force: true }); });

function submit(argsJson: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: argsJson } },
    { type: "done", finishReason: "tool_calls" },
  ];
}
/**
 * Read THEN write — the resolver is handed only the conflicted file NAMES, so it must look at a file before
 * replacing it. Overwriting a conflicted file blind would destroy one side of the merge, which is exactly what
 * write_file's read-before-overwrite guard refuses. Both calls ride the SAME turn, as a model would issue them.
 */
function writeTurn(path: string, content: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "r", name: "read_file", arguments: JSON.stringify({ path }) } },
    { type: "tool-call", toolCall: { id: "w", name: "write_file", arguments: JSON.stringify({ path, content }) } },
    { type: "done", finishReason: "tool_calls" },
  ];
}
const doneTurn: ChatEvent[] = [{ type: "text-delta", text: "ok" }, { type: "done", finishReason: "stop" }];

interface COpts { rounds?: number; askHuman?: AskHuman; signal?: AbortSignal }
function cdeps(provider: MockProvider, manager: ConflictDeps["manager"], opts: COpts = {}): ConflictDeps {
  const roles: Record<string, RoleConfig> = {
    operational: { models: ["m"], systemPrompt: "P-operational" },
    "code-reviewer": { models: ["m"], systemPrompt: "P-reviewer" },
  };
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: opts.signal ?? new AbortController().signal,
    specKit: fakeSpecKit,
    ...reviewBodies(),
    rounds: opts.rounds ?? 3,
    askHuman: opts.askHuman ?? (async () => ({ action: "abandon" })),
    manager,
  };
}
const hasContent = (p: MockProvider, needle: string): boolean =>
  p.requests.some((r) => r.messages.some((m) => typeof m.content === "string" && m.content.includes(needle)));

describe("resolveMergeConflict", () => {
  it("resolved: operational resolver(marker-free) → reviewer pass → commitMerge", async () => {
    const c = await createMergeConflict(); repo = c.repo;
    const board = new Board(); board.addCard({ id: "t1", title: "shared" });
    const p = new MockProvider([
      writeTurn("shared.txt", "MERGED\n"), doneTurn,
      submit('{"verdict":"pass","notes":[]}'),
    ]);
    const res = await resolveMergeConflict(cdeps(p, c.mgr), c.session, board, "t1", c.task);
    expect(res.status).toBe("resolved");
    expect(await c.mgr.unmergedFiles(c.session)).toEqual([]);
    expect(await readFile(join(c.session.baseWorktree, "shared.txt"), "utf8")).toBe("MERGED\n");
    const actions = board.get("t1")!.stageHistory.map((s) => s.action);
    expect(actions).toContain("conflict:resolve-attempt"); // operational did the resolution
    expect(actions).toContain("conflict:merged");
    const roles = board.get("t1")!.stageHistory.map((s) => s.role);
    expect(roles).toContain("operational");
  });

  it("marker remains → fail → retry; second attempt marker-free → resolved", async () => {
    const c = await createMergeConflict(); repo = c.repo;
    const board = new Board(); board.addCard({ id: "t1", title: "shared" });
    const p = new MockProvider([
      writeTurn("shared.txt", "<<<<<<< HEAD\nAAA\n=======\nBBB\n>>>>>>>\n"), doneTurn,
      writeTurn("shared.txt", "MERGED\n"), doneTurn,
      submit('{"verdict":"pass","notes":[]}'),
    ]);
    const res = await resolveMergeConflict(cdeps(p, c.mgr, { rounds: 2 }), c.session, board, "t1", c.task);
    expect(res.status).toBe("resolved");
    expect(await readFile(join(c.session.baseWorktree, "shared.txt"), "utf8")).toBe("MERGED\n");
  });

  it("reviewer fail → retry; hint carries over to the second operational attempt → resolved", async () => {
    const c = await createMergeConflict(); repo = c.repo;
    const board = new Board(); board.addCard({ id: "t1", title: "shared" });
    const p = new MockProvider([
      writeTurn("shared.txt", "M1\n"), doneTurn,
      submit('{"verdict":"fail","notes":["wrong-merge-ABC"]}'),
      writeTurn("shared.txt", "M2\n"), doneTurn,
      submit('{"verdict":"pass","notes":[]}'),
    ]);
    const res = await resolveMergeConflict(cdeps(p, c.mgr, { rounds: 2 }), c.session, board, "t1", c.task);
    expect(res.status).toBe("resolved");
    expect(await readFile(join(c.session.baseWorktree, "shared.txt"), "utf8")).toBe("M2\n");
    expect(hasContent(p, "wrong-merge-ABC")).toBe(true); // the failure hint reached the operational retry
  });

  it("N exhausted → askHuman abandon → abortMerge → {unresolved}", async () => {
    const c = await createMergeConflict(); repo = c.repo;
    const board = new Board(); board.addCard({ id: "t1", title: "shared" });
    const askHuman: AskHuman = async () => ({ action: "abandon" });
    const p = new MockProvider([
      writeTurn("shared.txt", "<<<<<<< stays\n"), doneTurn,
    ]);
    const res = await resolveMergeConflict(cdeps(p, c.mgr, { rounds: 1, askHuman }), c.session, board, "t1", c.task);
    expect(res.status).toBe("unresolved");
    expect(await c.mgr.unmergedFiles(c.session)).toEqual([]); // abortMerge → back to pre-merge state
    expect(board.get("t1")!.stageHistory.map((s) => s.action)).toContain("conflict:aborted");
  });

  it("N exhausted → askHuman retry(hint) → resolved on the second round; hint carries over to operational", async () => {
    const c = await createMergeConflict(); repo = c.repo;
    const board = new Board(); board.addCard({ id: "t1", title: "shared" });
    let asked = 0;
    const askHuman: AskHuman = async () => { asked++; return { action: "retry", notes: ["human-hint-XYZ"] }; };
    const p = new MockProvider([
      writeTurn("shared.txt", "<<<<<<< stays\n"), doneTurn,
      writeTurn("shared.txt", "MERGED\n"), doneTurn,
      submit('{"verdict":"pass","notes":[]}'),
    ]);
    const res = await resolveMergeConflict(cdeps(p, c.mgr, { rounds: 1, askHuman }), c.session, board, "t1", c.task);
    expect(res.status).toBe("resolved");
    expect(asked).toBe(1);
    expect(hasContent(p, "human-hint-XYZ")).toBe(true);
  });

  it("pre-aborted signal → rethrows (not swallowed)", async () => {
    const c = await createMergeConflict(); repo = c.repo;
    const ac = new AbortController(); ac.abort();
    const board = new Board(); board.addCard({ id: "t1", title: "shared" });
    const p = new MockProvider([writeTurn("shared.txt", "x\n"), doneTurn]);
    await expect(
      resolveMergeConflict(cdeps(p, c.mgr, { signal: ac.signal }), c.session, board, "t1", c.task),
    ).rejects.toThrow();
  });

  it("unknown task → error", async () => {
    const c = await createMergeConflict(); repo = c.repo;
    const p = new MockProvider([]);
    await expect(
      resolveMergeConflict(cdeps(p, c.mgr), c.session, new Board(), "missing", c.task),
    ).rejects.toThrow(/unknown task/);
  });
});
