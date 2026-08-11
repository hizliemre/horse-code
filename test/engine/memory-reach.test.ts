import { describe, it, expect } from "vitest";
import { buildRememberTool } from "../../src/tools/remember.js";
import { readOnlyRegistry } from "../../src/engine/reviewer.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";
import type { ToolContext } from "../../src/core/types.js";

/**
 * Every agent doing substantive work can teach the project something.
 *
 * The sink existed on every role's deps and exactly one role was wired to it: the coach. So a tester spent
 * 110 tool calls establishing which interceptor fills the audit columns, how the tenant filter is applied and
 * which columns exist — and had no tool with which to write any of it down. The next session started from
 * nothing and did it again. The reviewers had `propose_memory`, which queues for a curator that runs when the
 * job FINISHES; a verification session that is stopped halfway — and a long one usually is — carries none of
 * it either.
 */

const ctx = (): ToolContext => ({ cwd: ".", signal: new AbortController().signal } as ToolContext);

describe("remember_fact", () => {
  it("writes through on the call, so a stopped session still leaves it behind", async () => {
    const written: string[] = [];
    const t = buildRememberTool((f) => written.push(f));
    const r = await t.run({ fact: "audit columns are filled by SaveChangesInterceptor" }, ctx());
    expect(r.isError).toBe(false);
    expect(written).toEqual(["audit columns are filled by SaveChangesInterceptor"]);   // not queued
  });

  it("says what belongs in it, where the field is filled in", () => {
    const shape = (buildRememberTool().parameters as unknown as {
      shape: { fact: { description?: string } };
    }).shape;
    expect(shape.fact.description).toMatch(/durable and project-specific/i);
    expect(shape.fact.description).toMatch(/next agent would otherwise have to rediscover/i);
  });

  it("refuses politely when no sink is wired, rather than pretending", async () => {
    const r = await buildRememberTool().run({ fact: "x" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/memory is not available/);
  });

  it("keeps an empty fact out of the store", async () => {
    const written: string[] = [];
    const t = buildRememberTool((f) => written.push(f));
    expect((await t.run({ fact: "   " }, ctx())).isError).toBe(true);
    expect(written).toEqual([]);
  });
});

/**
 * Writing is for the roles doing the work, not for the lenses judging it.
 *
 * This distinction was already in the codebase and is worth keeping: a review lens is a narrow single-angle
 * finder on a cheap tier, and there are fifteen of them per change — "exactly the agents whose unsupervised
 * writes would poison the store". They propose; the curator decides. What was wrong was not that lenses are
 * fenced, but that the roles doing the finding were fenced with them.
 */
describe("who can write to memory", () => {
  const deps = (): TaskCycleDeps => ({ rememberFact: () => undefined } as unknown as TaskCycleDeps);

  it("a review lens still cannot — it proposes, and the curator decides", () => {
    const names = readOnlyRegistry(deps(), { propose: true }).list().map((t) => t.name);
    expect(names).toContain("propose_memory");
    expect(names).not.toContain("remember_fact");
  });

  it("a role that goes and finds things out can, when it is given the flag", () => {
    expect(readOnlyRegistry(deps(), { remember: true }).list().map((t) => t.name)).toContain("remember_fact");
  });

  it("is reachable from the registries built by hand, too", async () => {
    const files = ["src/engine/verify.ts", "src/engine/implementer.ts", "src/engine/conflict.ts",
      "src/speckit/phases.ts"];
    const { readFile } = await import("node:fs/promises");
    for (const f of files) {
      expect(await readFile(f, "utf8"), f).toContain("buildRememberTool");
    }
  });
});

/**
 * A tool an agent is not asked to use is a tool it does not use.
 *
 * `remember_fact` reached every substantive role and was called zero times across a whole run. Measured
 * across consecutive runs on the same project: a tester spent 110 tool calls working out which interceptor
 * fills the audit columns and the next run started from nothing; `psql` needed its password taken from the
 * container's own environment, and that was rediscovered by trial and error three runs running.
 *
 * The same shape as `grep`'s `include` and the `intent` enum before it — the capability existed, nothing
 * asked for it.
 */
describe("the prompt asks for what the tool offers", () => {
  const noteFor = async (names: string[]): Promise<string> => {
    const { projectToolsNote } = await import("../../src/engine/task-types.js");
    return projectToolsNote(names.map((name) => ({ name })) as never, false);
  };

  it("tells a role holding remember_fact to use it", async () => {
    const note = await noteFor(["read_file", "remember_fact"]);
    expect(note).toMatch(/What you work out, keep/);
    expect(note).toMatch(/writes to this project's memory immediately/);
  });

  it("names the moment — something that cost more than one attempt", async () => {
    const note = await noteFor(["remember_fact"]);
    expect(note).toMatch(/cost you more than one attempt/);
    expect(note).toMatch(/which command works here and how it must be invoked/);
  });

  it("says what NOT to write, so the store does not fill with noise", async () => {
    const note = await noteFor(["remember_fact"]);
    expect(note).toMatch(/Do not record what you did/);
    expect(note).toMatch(/true of the language or framework in general/);
  });

  it("says nothing to a role that cannot write — a review lens is not told to remember", async () => {
    const note = await noteFor(["read_file", "grep", "propose_memory"]);
    expect(note).not.toMatch(/What you work out, keep/);
  });
});
