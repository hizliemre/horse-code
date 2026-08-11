import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

/**
 * The implementer is the one participant that cannot know whether the work is done.
 *
 * Measured live: the card read `coder small-1 — Uygulama tamamlandı.` ("implementation complete"), and the
 * very next thing on the screen was four review lenses opening the same diff — two of them rejecting it —
 * and a five-member council voting on what to do about it. Reported by the user watching: "uygulama
 * tamamlandı dedi ama sonrasında review'e başladı. review bitmeden uygulama tamamlandı dememeli."
 *
 * A source assertion, not a behavioural one: what closes an implementer's turn is prose from a model, and
 * the only place this can be decided is the instruction it was given.
 */
describe("what an implementer is told about stopping", () => {
  const src = (): Promise<string> => readFile("src/engine/implementer.ts", "utf8");

  it("calls it a hand-over, and names who decides instead", async () => {
    const s = await src();
    expect(s).toContain("you are HANDING the change over");
    expect(s).toContain("a review and an acceptance check that have not run");
    expect(s.replace(/`\s*\+\s*`/g, "")).toContain("do not write that the task is complete, done or finished");
  });

  it("still asks for what it changed and what it ran — the part that IS its to say", async () => {
    expect(await src()).toContain("close with what you changed and what you ran");
  });

  it("reaches the implementer's own message, not just the file", async () => {
    const s = await src();
    expect(s).toContain("${hygiene}\\n\\n${handOver}");
  });
});
