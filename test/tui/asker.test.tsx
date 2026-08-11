import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { MetricsLine } from "../../src/tui/components.js";
import { buildAskUserTool } from "../../src/engine/writer-registry.js";
import type { AskOpts } from "../../src/engine/review.js";

/**
 * A question on the screen is asked BY somebody.
 *
 * The line under the input box read `cc/claude-sonnet-5` and nothing else. A run has a dozen models in it and
 * every role borrows one, so the id names a machine and not a situation — reported while looking at a
 * hand-off: "input'un altındaki dil modeli kime ait? role belli değil". The tester had stopped mid-scenario
 * to ask the developer to click through a screen, and the screen said nothing about that.
 */
const meta = { durationMs: 0, calls: 0, promptTokens: 0, completionTokens: 0 } as never;

describe("the line under the input", () => {
  it("names the role that is waiting, beside the model it is running on", () => {
    const { lastFrame } = render(
      <MetricsLine meta={meta} model="cc/claude-opus-4-8" asker={{ role: "tester", model: "cc/claude-sonnet-5" }} />);
    expect(lastFrame()).toContain("tester");
    // The ASKER's model, not the session's — it is the one that will read the answer.
    expect(lastFrame()).toContain("cc/claude-sonnet-5");
    expect(lastFrame()).not.toContain("opus");
  });

  it("still shows the session's model when nothing is being asked", () => {
    const { lastFrame } = render(<MetricsLine meta={meta} model="cc/claude-opus-4-8" />);
    expect(lastFrame()).toContain("cc/claude-opus-4-8");
    expect(lastFrame()).not.toContain("·");
  });

  it("shows an asker with no model of its own by name alone", () => {
    const { lastFrame } = render(<MetricsLine meta={meta} model="cc/claude-opus-4-8" asker={{ role: "coach" }} />);
    expect(lastFrame()).toContain("coach · cc/claude-opus-4-8");
  });
});

describe("ask_user", () => {
  const runAsk = async (ctx: Record<string, unknown>): Promise<AskOpts | undefined> => {
    let seen: AskOpts | undefined;
    const tool = buildAskUserTool(async (_q, o) => { seen = o; return "ok"; });
    await tool.run({ question: "What does the screen show?" },
      { cwd: ".", signal: new AbortController().signal, ...ctx } as never);
    return seen;
  };

  it("says who is asking, so the box can name them", async () => {
    expect(await runAsk({ role: "tester", model: "cc/claude-sonnet-5" }))
      .toMatchObject({ asker: { role: "tester", model: "cc/claude-sonnet-5" } });
  });

  it("says nothing when it has nothing to say — a question is still a question", async () => {
    expect(await runAsk({})).not.toHaveProperty("asker");
  });
});
