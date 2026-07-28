import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { commitStep, commitFile, fileCommitMessage, runOperational } from "../../src/engine/operational.js";
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

  /**
   * Every file an implementer wrote used to cost a BLOCKING call to phrase its commit, in series, inside the
   * attempt's twenty-minute budget — fifteen files, fifteen inline round-trips. And it describes the wrong
   * unit: "persist the sort preference" is what the TASK did, not what one of its five files did.
   */
  it("commitFile commits only the given file, and spends nothing on phrasing it", async () => {
    repo = await initTmpRepo();
    const g = (args: string[]) => defaultGitRunner(args, repo!);
    await writeFile(join(repo, "a.md"), "# A", "utf8");
    await writeFile(join(repo, "b.md"), "# B", "utf8"); // a second, unrelated change
    const p = new MockProvider([submit("docs: add a.md")]);
    const notes: string[] = [];
    const msg = await commitFile({ ...deps(p), note: (t) => notes.push(t) }, repo, "a.md");
    expect(p.requests).toHaveLength(0); // no model call to write a commit message
    expect(msg).toBe("docs: update a.md");
    expect(notes).toContain("🔖 docs: update a.md"); // still surfaced in the chat flow
    // only a.md was committed; b.md is still uncommitted
    expect((await g(["log", "-1", "--format=%s"])).stdout.trim()).toBe("docs: update a.md");
    expect((await g(["status", "--porcelain"])).stdout).toContain("b.md");
    expect((await g(["status", "--porcelain"])).stdout).not.toContain("a.md");
  });

  describe("fileCommitMessage", () => {
    it("labels a test file as a test change", () => {
      expect(fileCommitMessage("tests/store.spec.ts")).toMatch(/^test/);
      expect(fileCommitMessage("src/app/store.spec.ts")).toMatch(/^test/);
    });

    it("labels build configuration as build", () => {
      expect(fileCommitMessage("package.json")).toMatch(/^build/);
      expect(fileCommitMessage("angular.json")).toMatch(/^build/);
      expect(fileCommitMessage("vite.config.ts")).toMatch(/^build/);
    });

    it("labels prose as docs", () => {
      expect(fileCommitMessage("README.md")).toMatch(/^docs/);
    });

    it("scopes by the containing folder, and never by a bare src", () => {
      expect(fileCommitMessage("src/store/todo.ts")).toBe("chore(store): update todo.ts");
      expect(fileCommitMessage("src/todo.ts")).toBe("chore: update todo.ts");
    });

    it("survives a bare filename and a windows path", () => {
      expect(fileCommitMessage("Makefile")).toBe("chore: update Makefile");
      expect(fileCommitMessage("src\\app\\x.ts")).toContain("x.ts");
    });
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
