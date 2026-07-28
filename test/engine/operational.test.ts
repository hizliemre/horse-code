import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { commitStep, commitFile, fileCommitMessage, squashTask, runOperational } from "../../src/engine/operational.js";
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
    expect(msg).toBe("wip(docs): a.md");
    expect(notes).toContain("🔖 wip(docs): a.md"); // still surfaced in the chat flow
    // only a.md was committed; b.md is still uncommitted
    expect((await g(["log", "-1", "--format=%s"])).stdout.trim()).toBe("wip(docs): a.md");
    expect((await g(["status", "--porcelain"])).stdout).toContain("b.md");
    expect((await g(["status", "--porcelain"])).stdout).not.toContain("a.md");
  });

  /**
   * These are CHECKPOINTS, not history: `squashTask` replaces the lot with one real message when the task
   * lands. They say `wip` so that nothing reads them as a conventional-commit claim about the change.
   */
  describe("fileCommitMessage", () => {
    it("marks every checkpoint as work in progress", () => {
      expect(fileCommitMessage("src/store/todo.ts")).toMatch(/^wip\(/);
      expect(fileCommitMessage("README.md")).toMatch(/^wip\(/);
    });

    it("says what kind of file it was, so the checkpoint list is still scannable", () => {
      expect(fileCommitMessage("tests/store.spec.ts")).toContain("test");
      expect(fileCommitMessage("src/app/store.spec.ts")).toContain("test");
      expect(fileCommitMessage("package.json")).toContain("build");
      expect(fileCommitMessage("angular.json")).toContain("build");
      expect(fileCommitMessage("README.md")).toContain("docs");
    });

    it("scopes by the containing folder, and never by a bare src", () => {
      expect(fileCommitMessage("src/store/todo.ts")).toBe("wip(chore/store): todo.ts");
      expect(fileCommitMessage("src/todo.ts")).toBe("wip(chore): todo.ts");
    });

    it("survives a bare filename and a windows path", () => {
      expect(fileCommitMessage("Makefile")).toBe("wip(chore): Makefile");
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

/**
 * The base branch was carrying thirty lines of `update local-change-transport.ts` per task — true, and
 * silent about what the task did or why. Writing a real message for each of them was worse: a blocking model
 * call after every single write, inside the attempt's budget.
 *
 * A task is the unit a commit message describes, so the checkpoints are squashed and one message is written
 * from the whole diff.
 */
describe("squashTask", () => {
  const commitFiles = async (repo: string, files: [string, string][]): Promise<void> => {
    for (const [name, body] of files) {
      await writeFile(join(repo, name), body, "utf8");
      await defaultGitRunner(["add", "--", name], repo);
      await defaultGitRunner(["commit", "-m", `wip(chore): ${name}`], repo);
    }
  };

  it("replaces the checkpoints with one message written from the whole diff", async () => {
    repo = await initTmpRepo();
    const g = (args: string[]) => defaultGitRunner(args, repo!);
    const before = (await g(["rev-parse", "HEAD"])).stdout.trim();
    await commitFiles(repo, [["a.ts", "export const a = 1;\n"], ["b.ts", "export const b = 2;\n"]]);
    const p = new MockProvider([submit("feat(core): add the a and b constants")]);
    const msg = await squashTask(deps(p), repo, before, "Add a and b");
    expect(msg).toBe("feat(core): add the a and b constants");
    expect((await g(["log", "-1", "--format=%s"])).stdout.trim()).toBe("feat(core): add the a and b constants");
    // one commit on top of the fork point, not three
    expect((await g(["rev-list", "--count", `${before}..HEAD`])).stdout.trim()).toBe("1");
  });

  /** --soft moves the branch pointer only: every byte the task wrote is still in the tree. */
  it("keeps every file the task wrote", async () => {
    repo = await initTmpRepo();
    const before = (await defaultGitRunner(["rev-parse", "HEAD"], repo)).stdout.trim();
    await commitFiles(repo, [["a.ts", "export const a = 1;\n"]]);
    await squashTask(deps(new MockProvider([submit("feat: add a")])), repo, before, "Add a");
    expect(await readFile(join(repo, "a.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  /** The task's own title still says what it was — far better than losing the commit entirely. */
  it("falls back to the task title when the operational agent fails", async () => {
    repo = await initTmpRepo();
    const before = (await defaultGitRunner(["rev-parse", "HEAD"], repo)).stdout.trim();
    await commitFiles(repo, [["a.ts", "x\n"]]);
    const p = new MockProvider([[{ type: "error", message: "boom" }]]);
    expect(await squashTask(deps(p), repo, before, "Add the a module")).toBe("chore: Add the a module");
  });

  it("does nothing when the task committed nothing", async () => {
    repo = await initTmpRepo();
    const head = (await defaultGitRunner(["rev-parse", "HEAD"], repo)).stdout.trim();
    const p = new MockProvider([submit("feat: nothing")]);
    expect(await squashTask(deps(p), repo, head, "Nothing")).toBeUndefined();
    expect(p.requests).toHaveLength(0); // and asks nobody to phrase it
  });

  it("does not raise when the base ref is unknown", async () => {
    repo = await initTmpRepo();
    await expect(squashTask(deps(new MockProvider([])), repo, "no-such-ref", "X")).resolves.toBeUndefined();
  });
});
