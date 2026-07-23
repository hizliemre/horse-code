import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commitStep, runOperational } from "../../src/engine/operational.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { MockProvider } from "../../src/providers/mock.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import type { ChatEvent } from "../../src/core/types.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";
import { initTmpRepo } from "../worktree/helpers.js";

let repo: string | undefined;
afterEach(async () => { if (repo) await rm(repo, { recursive: true, force: true }); repo = undefined; });

function submit(msg: string): ChatEvent[] {
  return [{ type: "tool-call", toolCall: { id: "s", name: "submit", arguments: JSON.stringify({ message: msg }) } }, { type: "done", finishReason: "tool_calls" }];
}
function deps(provider: MockProvider): TaskCycleDeps {
  return {
    provider,
    roleRegistry: new RoleRegistry({ operational: { models: ["m"], systemPrompt: "You write Conventional Commits messages." } }, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: new AbortController().signal,
    specKit: async () => ({ command: () => "" } as never),
  };
}

describe("runOperational", () => {
  it("turns a diff into the operational agent's Conventional Commits message", async () => {
    const p = new MockProvider([submit("feat(spec): add feature specification")]);
    const msg = await runOperational(deps(p), "+ # Feature Spec\n+ ...", "add the spec");
    expect(msg).toBe("feat(spec): add feature specification");
  });
});

describe("commitStep", () => {
  it("commits the worktree with the operational message; no-op when nothing changed", async () => {
    repo = await initTmpRepo();
    const g = (args: string[]) => defaultGitRunner(args, repo!);

    // nothing changed → no commit, no operational call
    const p0 = new MockProvider([submit("should-not-be-used")]);
    expect(await commitStep(deps(p0), repo, "nothing")).toBeUndefined();

    // a new file → committed with the operational message
    await writeFile(join(repo, "spec.md"), "# spec", "utf8");
    const p1 = new MockProvider([submit("docs(spec): add feature specification")]);
    const committed = await commitStep(deps(p1), repo, "add the spec");
    expect(committed).toBe("docs(spec): add feature specification");
    const log = await g(["log", "-1", "--format=%s"]);
    expect(log.stdout.trim()).toBe("docs(spec): add feature specification");
    // working tree is clean now
    expect((await g(["status", "--porcelain"])).stdout.trim()).toBe("");
  });

  it("falls back to a deterministic message when the operational agent errors (still commits)", async () => {
    repo = await initTmpRepo();
    await writeFile(join(repo, "x.txt"), "hi", "utf8");
    const p = new MockProvider([[{ type: "error", message: "boom" }]]); // operational agent fails
    const committed = await commitStep(deps(p), repo, "add x");
    expect(committed).toBe("chore: add x"); // fallback, but the work is still committed
    const log = await defaultGitRunner(["log", "-1", "--format=%s"], repo);
    expect(log.stdout.trim()).toBe("chore: add x");
  });
});
