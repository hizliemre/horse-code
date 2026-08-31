import { describe, it, expect } from "vitest";
import { workingDirectoryNote, runRoleAgent } from "../../src/agent/loop.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { Provider } from "../../src/core/types.js";
import type { RoleAgentOptions } from "../../src/agent/loop.js";

/** Captures the system prompt the provider is actually sent. */
function capturing(): { system: string[]; provider: Provider } {
  const system: string[] = [];
  const provider: Provider = {
    async *chat(req) {
      const first = req.messages[0];
      system.push(typeof first?.content === "string" ? first.content : "");
      yield { type: "text-delta", text: "done" };
      yield { type: "done", finishReason: "stop" };
    },
  };
  return { system, provider };
}

const opts = (provider: Provider, cwd = ""): RoleAgentOptions => ({
  provider, model: "m", systemPrompt: "P-role",
  tools: new ToolRegistry(), messages: [{ role: "user", content: "do it" }],
  permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
  approve: async () => true,
  signal: new AbortController().signal,
  cwd,
});

const drain = async (o: RoleAgentOptions): Promise<void> => { for await (const _ of runRoleAgent(o)) { /* … */ } };

/**
 * Nothing ever told an agent where it was.
 *
 * Every tool resolves relative paths against `cwd`, and no prompt named it. Measured on a live revision
 * round: the reviser opened with `ls`, `pwd && git status`, `git worktree list && git rev-parse
 * --show-toplevel`, and `cd /Users/…/parrot && git status` — four calls to establish where it was — then
 * prefixed `cd <absolute path>` to twenty-eight of its remaining shell commands. It used all 56 of its turns
 * orienting and reading, and wrote nothing. A checkout under `.horsecode/worktrees/<slug>/base` is not
 * somewhere an agent can guess it is.
 */
describe("an agent is told where it is", () => {
  it("names the directory, and says relative paths resolve from it", () => {
    const note = workingDirectoryNote("/p/.horsecode/worktrees/x/base");
    expect(note).toContain("/p/.horsecode/worktrees/x/base");
    expect(note).toMatch(/relative path/i);
  });

  it("tells it not to go hunting for the repository", () => {
    const note = workingDirectoryNote("/p/base");
    expect(note).toMatch(/do not `cd` elsewhere/i);
    expect(note).toMatch(/looking for the repository/i);
  });

  it("reaches the model, appended to whatever the role's own prompt says", async () => {
    const { system, provider } = capturing();
    await drain(opts(provider, "/p/.horsecode/worktrees/x/base"));
    expect(system[0]).toContain("P-role");
    expect(system[0]).toContain("/p/.horsecode/worktrees/x/base");
  });

  /** A role with no directory of its own is told nothing, rather than told something invented. */
  it("says nothing when there is no working directory", async () => {
    const { system, provider } = capturing();
    await drain(opts(provider));
    expect(system[0]).toBe("P-role");
  });
});

/**
 * "work in the main worktree" pointed away from where the reviser already was.
 *
 * It runs in the session's base checkout; that phrase reads as the project's own, and that is exactly where
 * it went — `git worktree list`, `cd /Users/…/parrot && git status`, `find . -name "*-pr-revision*"`.
 */
describe("the reviser's instruction", () => {
  it("no longer sends it somewhere else", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/engine/revision.ts", "utf8");
    const ask = src.slice(src.indexOf("const ask = {"), src.indexOf("const ask = {") + 500);
    expect(ask).not.toContain("main worktree");
    expect(ask).toMatch(/Start by editing/);
  });
});

/**
 * What a fresh worktree does NOT have, which agents were left to discover by failing.
 *
 * Measured on a 124-task run: turns spent on `ls …/toucan/node_modules`, on a NuGet restore that could not
 * find its lock file, and on a `find` pruning a directory that was not there. A session worktree is a clean
 * git checkout, so everything git ignores is absent — `node_modules` above all, and it is deliberately not
 * inherited because a blanket copy of ignored files would drag gigabytes into every session.
 *
 * Stated, not prescribed: whether to install anything is a judgement about the project and the task, and
 * eight parallel worktrees each running an install is its own kind of expensive. The agent could not weigh
 * that before, because it did not know.
 */
describe("what an agent is told about where it is standing", () => {
  const inWorktree = "/proj/.horsecode/worktrees/07-Sep-2026-MONDAY_01/tasks/some-task";

  it("names what is missing, inside a session worktree", () => {
    const note = workingDirectoryNote(inWorktree);
    expect(note).toContain("fresh git worktree");
    expect(note).toContain("node_modules");
    expect(note).toContain("build output");
  });

  /** …and says what IS there, so "absent" is not read as "incomplete checkout". */
  it("says the code itself is present and current", () => {
    expect(workingDirectoryNote(inWorktree)).toMatch(/Source, tests and configuration are all here/);
  });

  /** A plain project directory is not a worktree and must not be told it is missing anything. */
  it("says none of it when the agent is in an ordinary directory", () => {
    const note = workingDirectoryNote("/proj");
    expect(note).toContain("/proj");
    expect(note).not.toContain("node_modules");
    expect(note).not.toContain("fresh git worktree");
  });

  it("still says the thing it always said", () => {
    for (const cwd of [inWorktree, "/proj"]) {
      expect(workingDirectoryNote(cwd)).toContain("do not `cd` elsewhere");
    }
  });
});
