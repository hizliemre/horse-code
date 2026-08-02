import { describe, it, expect } from "vitest";
import { DEFAULT_PROMPTS } from "../../src/prompts.js";

/**
 * Measured on a real session: the coach made 30 tool calls — 18 globs, 5 reads, 5 greps — across 16 model
 * calls, and emitted no prose at all. The plumbing that carries what a role says to the screen was working;
 * there was simply nothing to carry. A search that reads thirty files in silence looks exactly like a run
 * that has hung, and cannot be redirected before the tokens are spent.
 */
describe("the coach is told to work out loud", () => {
  it("asks for a line before a batch of tool calls, not a summary at the end", () => {
    expect(DEFAULT_PROMPTS.coach).toMatch(/Work out loud/);
    expect(DEFAULT_PROMPTS.coach).toMatch(/not a summary at the end/i);
  });

  it("bounds it, so narration does not become the answer", () => {
    expect(DEFAULT_PROMPTS.coach).toMatch(/ONE line/);
    expect(DEFAULT_PROMPTS.coach).toMatch(/a sentence, not a paragraph/i);
  });
});
