import { describe, it, expect } from "vitest";
import { z } from "zod";
import { buildSubmitTool, whatWasWrong } from "../../src/agent/structured.js";

const run = async (schema: z.ZodType<unknown>, args: unknown): Promise<string> => {
  const { tool } = buildSubmitTool(schema);
  const r = await tool.run(args as never, {} as never);
  return r.content;
};

const KIND = z.object({ kind: z.enum(["chat", "feature", "bugfix", "govern", "undo", "verify"]) });

/**
 * Four model turns spent guessing, because the message described the law and not the violation.
 *
 * Measured on a live run: the refiner submitted an invalid `kind` and was told `Invalid option: expected one
 * of "chat"|"feature"|"bugfix"|"govern"|"undo"|"verify"`. It said nothing about WHICH field was wrong or
 * what had been put there, so each retry was a fresh guess. It took five attempts to land a legal value.
 */
describe("what a rejected submit tells the model", () => {
  it("names the field and the value it was given", async () => {
    const text = await run(KIND, { kind: "refactor" });
    expect(text).toContain("kind:");
    expect(text).toContain('got "refactor"');
    expect(text).toContain("feature"); // the legal set is still there — it was the useful half
  });

  /** "Nothing" and "the wrong thing" are different mistakes and need different corrections. */
  it("distinguishes a missing field from a wrong one", async () => {
    expect(await run(KIND, {})).toContain("got nothing");
    expect(await run(KIND, { kind: 3 })).toContain("got 3");
  });

  it("reaches into nested paths rather than reporting the root", async () => {
    const schema = z.object({ plan: z.object({ rounds: z.number() }) });
    const text = await run(schema, { plan: { rounds: "three" } });
    expect(text).toContain("plan.rounds:");
    expect(text).toContain('got "three"');
  });

  /** A value big enough to be the problem itself must not become the whole message. */
  it("truncates a value that is too long to quote", async () => {
    const schema = z.object({ title: z.number() });
    const text = await run(schema, { title: "x".repeat(500) });
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(300);
  });

  it("still accepts what is valid, and says so", async () => {
    const { tool, result } = buildSubmitTool(KIND);
    const r = await tool.run({ kind: "feature" } as never, {} as never);
    expect(r.isError).toBe(false);
    expect(result()).toEqual({ value: { kind: "feature" } });
  });

  it("reports every issue when several fields are wrong at once", () => {
    const schema = z.object({ a: z.string(), b: z.number() });
    const parsed = schema.safeParse({ a: 1, b: "two" });
    const text = whatWasWrong(parsed.error!.issues, { a: 1, b: "two" });
    expect(text).toContain("a:");
    expect(text).toContain("b:");
    expect(text).toContain("got 1");
    expect(text).toContain('got "two"');
  });
});
