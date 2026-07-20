import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runImplementer } from "../../src/engine/implementer.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { Card, Board } from "../../src/board/board.js";
import type { ChatEvent } from "../../src/core/types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-impl-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function deps(provider: MockProvider): TaskCycleDeps {
  return {
    provider,
    roleRegistry: new RoleRegistry({ coder: { models: ["m"], systemPrompt: "sen coder'sın" } }, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: new AbortController().signal,
  };
}
const card = (over: Partial<Card> = {}): Card => ({
  id: "t1", title: "dosya yaz", column: "IN-PROGRESS", deps: [], reviewNotes: [], attempts: 0, stageHistory: [], ...over,
});
function writeThenDone(): ChatEvent[][] {
  return [
    [
      { type: "tool-call", toolCall: { id: "w1", name: "write_file", arguments: '{"path":"out.txt","content":"merhaba"}' } },
      { type: "done", finishReason: "tool_calls" },
    ],
    [{ type: "text-delta", text: "bitti" }, { type: "done", finishReason: "stop" }],
  ];
}

describe("runImplementer", () => {
  it("implementer worktree'ye dosya yazar (cwd = worktree)", async () => {
    const p = new MockProvider(writeThenDone());
    await runImplementer(deps(p), "coder", card(), dir);
    expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("merhaba");
  });

  it("dönen task'ta mesaj reviewNotes'u içerir", async () => {
    const p = new MockProvider([[{ type: "text-delta", text: "ok" }, { type: "done", finishReason: "stop" }]]);
    await runImplementer(deps(p), "coder", card({ reviewNotes: ["testi düzelt"] }), dir);
    const msg = p.requests[0].messages.map((m) => m.content).join("\n");
    expect(msg).toContain("DÖNEN");
    expect(msg).toContain("testi düzelt");
  });
});
