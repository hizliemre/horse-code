import { describe, it, expect } from "vitest";
import { runReviewer } from "../../src/engine/reviewer.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { Card } from "../../src/board/board.js";
import type { ChatEvent } from "../../src/core/types.js";
import { fakeSpecKit } from "../support/fake-speckit.js";

function submitTurn(argsJson: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "s1", name: "submit", arguments: argsJson } },
    { type: "done", finishReason: "tool_calls" },
  ];
}
const card = (): Card => ({ id: "t1", title: "X", column: "REVIEW", deps: [], acceptance: [], reviewNotes: [], attempts: 0, stageHistory: [] });
function deps(provider: MockProvider): TaskCycleDeps {
  return {
    provider,
    roleRegistry: new RoleRegistry({ "code-reviewer": { models: ["m"], systemPrompt: "you are the reviewer" } }, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: new AbortController().signal,
    specKit: fakeSpecKit,
  };
}

describe("runReviewer", () => {
  it("returns a structured verdict", async () => {
    const p = new MockProvider([submitTurn('{"verdict":"fail","notes":["there is an error"]}')]);
    expect(await runReviewer(deps(p), card(), "/tmp")).toEqual({ verdict: "fail", notes: ["there is an error"] });
  });

  it("scopes the review to the task's CODE and excludes the already-approved upstream docs", async () => {
    const p = new MockProvider([submitTurn('{"verdict":"pass","notes":[]}')]);
    await runReviewer(deps(p), card(), "/tmp");
    const msg = p.requests[0].messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(msg).toMatch(/code/i);
    expect(msg).toMatch(/do not review[\s\S]*specs|\.specify|plan\.md|tasks\.md/i); // don't re-review spec/plan/tasks
  });

  it("toolset is read-only (no write/edit/shell)", async () => {
    const p = new MockProvider([submitTurn('{"verdict":"pass","notes":[]}')]);
    await runReviewer(deps(p), card(), "/tmp");
    const toolNames = p.requests[0].tools.map((t) => t.name);
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("grep");
    expect(toolNames).not.toContain("write_file");
    expect(toolNames).not.toContain("edit_file");
    expect(toolNames).not.toContain("shell");
  });
});
