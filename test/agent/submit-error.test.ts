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

/**
 * Zod frequently names what arrived — "expected array, received undefined" — and appending "got nothing" to
 * that says it twice. Seen live: `plan: Invalid input: expected array, received undefined — got nothing`.
 */
describe("not saying the same thing twice", () => {
  it("drops the got-clause when the rule already stated what arrived", async () => {
    const text = await run(z.object({ plan: z.array(z.string()) }), {});
    expect(text).toContain("plan:");
    expect(text).not.toContain("got nothing");
  });

  /** …but a real value is exactly what the rule does not state, and must survive. */
  it("keeps it when there is an actual value to name", async () => {
    const text = await run(z.object({ plan: z.array(z.string()) }), { plan: "not an array" });
    expect(text).toContain('got "not an array"');
  });
});

/**
 * A missing field and a malformed one are different mistakes, and the model cannot see which it made.
 *
 * Measured live: the architect on T103 was rejected four times with `plan: Invalid input: expected array,
 * received undefined`. The field was absent entirely — it had submitted a root cause and nothing else — and
 * the message described what it wanted without saying what had arrived, so "you forgot a field" and "your
 * field is the wrong shape" read identically.
 */
describe("a field that never arrived", () => {
  const SCHEMA = z.object({ rootCause: z.string(), plan: z.array(z.string()) });

  it("names the keys that were sent", async () => {
    const text = await run(SCHEMA, { rootCause: "the mapping is wrong" });
    expect(text).toContain("plan:");
    expect(text).toContain("you sent only `rootCause`");
  });

  it("lists several when several arrived", async () => {
    const text = await run(z.object({ a: z.string(), b: z.string(), c: z.string() }), { a: "x", b: "y" });
    expect(text).toContain("`a`");
    expect(text).toContain("`b`");
  });

  /** An empty submission has nothing to name, and must not claim it sent something. */
  it("says nothing extra when nothing was sent", async () => {
    const text = await run(SCHEMA, {});
    expect(text).not.toContain("you sent only");
  });

  /** A field that arrived WRONG still gets its value quoted — that half must not regress. */
  it("still quotes a value that is present but malformed", async () => {
    const text = await run(SCHEMA, { rootCause: "x", plan: "do the thing" });
    expect(text).toContain('got "do the thing"');
  });
});
