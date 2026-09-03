import { describe, it, expect } from "vitest";
import { cliModel, cliEffort, promptFor, cliFor, CliProvider } from "../../src/agents/cli-provider.js";
import type { ChatRequest } from "../../src/core/types.js";
import { makeStreamReader, decodeClaudeEvent } from "../../src/agents/cli-agent.js";

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

/**
 * Which CLI serves a model, read from the id the role registry already uses.
 *
 * The catalog prefixes outlive the gateway: `cc/` was always Claude, `cx/` always Codex, and `sourceOf` has
 * normalised them that way since long before this transport. Reusing them is what lets a config of
 * sixty-four tuned role chains keep working instead of every model in it being renamed.
 */
describe("choosing a CLI from the model id", () => {
  it("routes the two sources that have a binary", () => {
    expect(cliFor("cc/claude-opus-5")).toBe("claude");
    expect(cliFor("no-think/cc/claude-sonnet-5")).toBe("claude");
    expect(cliFor("cx/gpt-5.6-terra-high")).toBe("codex");
  });

  /**
   * `antigravity/` was a gateway source and no binary serves it. A role still pointing at one must fail
   * loudly — served quietly by a default CLI, the answer would be attributed to a model that never ran.
   */
  it("refuses a source no CLI can serve", () => {
    expect(cliFor("antigravity/claude-sonnet-4-6")).toBeUndefined();
    expect(cliFor("opencode-go/hy3")).toBeUndefined();
  });
});

/** …and the refusal reaches the chain as a model failure, so the bench and the fallback both apply. */
describe("a model with no CLI", () => {
  it("errors retryably instead of running on whichever CLI was default", async () => {
    const p = new CliProvider();
    const out = [];
    for await (const ev of p.chat(req({ model: "antigravity/claude-sonnet-4-6" }), new AbortController().signal)) {
      out.push(ev);
    }
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "error", retryable: true });
    expect(out[0].type === "error" && out[0].message).toMatch(/no CLI serves/);
  });
});

/**
 * A delegated agent showed "starting up…" for its whole life.
 *
 * The live row's activity line reads the tool calls this process's executor recorded, and a delegated agent
 * runs its tools in another one — so the row said nothing while its clock and token count climbed beside it.
 * That row is the one thing a person watches to know what is happening.
 *
 * The provider knows WHAT was done; the loop knows WHO did it, because the implementer binds the sink to its
 * card. So the provider reports the call and the loop attributes it.
 */
describe("reporting what the CLI's own agent did", () => {
  it("turns the CLI's tool calls into activity events", async () => {
    const events: string[] = [];
    const stream = [
      '{"type":"assistant","message":{"model":"claude-opus-5","content":[{"type":"tool_use","id":"t1",'
        + '"name":"Write","input":{"file_path":"src/a.ts"}}]}}',
      '{"type":"assistant","message":{"model":"claude-opus-5","content":[{"type":"text","text":"done"}]}}',
      '{"type":"result","subtype":"success","usage":{"input_tokens":1,"output_tokens":1}}',
    ].join("\n");
    const reader = makeStreamReader(decodeClaudeEvent, (ev) => { if (ev.tool) events.push(`${ev.tool.name}:${ev.tool.target}`); });
    reader.push(stream); reader.end();
    expect(events).toEqual(["Write:src/a.ts"]);
  });
});
