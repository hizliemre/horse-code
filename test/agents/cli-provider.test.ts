import { describe, it, expect } from "vitest";
import { cliModel, cliEffort, promptFor } from "../../src/agents/cli-provider.js";
import type { ChatRequest } from "../../src/core/types.js";

const req = (over: Partial<ChatRequest> = {}): ChatRequest =>
  ({ model: "cc/claude-opus-5", messages: [{ role: "user", content: "hi" }], tools: [], ...over });

/**
 * A horse-code id names a source, a model and often an effort level; the CLI's `--model` wants the model
 * alone. Getting this wrong is silent — the CLI falls back to its default and every role runs on the same
 * model, which is precisely the assignment the whole role registry exists to avoid.
 */
describe("mapping a horse-code model id onto the CLI's own", () => {
  it("drops the source prefix and the effort suffix", () => {
    expect(cliModel("cc/claude-opus-5-high")).toBe("claude-opus-5");
    expect(cliModel("no-think/cc/claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(cliModel("cx/gpt-5.6-terra-max")).toBe("gpt-5.6-terra");
  });

  it("reads the level the id spells out", () => {
    expect(cliEffort("cx/gpt-5.5-xhigh")).toBe("xhigh");
    expect(cliEffort("cc/claude-opus-5")).toBeUndefined();
  });
});

/**
 * A headless call takes ONE string, so the message roles have to be written into it. An unlabelled
 * concatenation reads as one wall of text and the model cannot tell an instruction from a quotation.
 */
describe("folding a conversation into one prompt", () => {
  it("keeps the turns apart and marks whose is whose", () => {
    const p = promptFor(req({ messages: [
      { role: "system", content: "you are a reviewer" },
      { role: "user", content: "review this" },
      { role: "assistant", content: "I found one thing" },
      { role: "user", content: "and the tests?" },
    ] }));
    expect(p).toContain("you are a reviewer");
    expect(p).toContain("[your previous reply]\nI found one thing");
    expect(p.indexOf("review this")).toBeLessThan(p.indexOf("and the tests?"));
  });

  /**
   * The bridge for a structured role: the `submit` tool cannot be called across a process boundary, so the
   * shape it would have validated is stated instead and the caller's existing JSON salvage validates it.
   */
  it("states the submit schema when the role has one", () => {
    const schema = { type: "object", properties: { verdict: { type: "string" } } };
    const p = promptFor(req({ tools: [{ name: "submit", description: "d", parameters: schema }] }));
    expect(p).toContain("ONE JSON object");
    expect(p).toContain('"verdict"');
  });

  it("says nothing about JSON for a role that has no submit", () => {
    expect(promptFor(req())).not.toContain("ONE JSON object");
  });

  /** An empty turn contributes nothing but a blank gap — the prompt is already long enough. */
  it("skips empty turns", () => {
    const p = promptFor(req({ messages: [{ role: "user", content: "  " }, { role: "user", content: "real" }] }));
    expect(p.trim()).toBe("real");
  });
});
