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

/**
 * The tool was there, the instruction was there, and it was used zero times.
 *
 * Measured over one whole run: 153 tool calls by a single implementer, ten of them failed shell commands
 * working out that this project's formatter has to be invoked from a subdirectory — and not one
 * `remember_fact`. The next run pays for all of it again.
 *
 * A standing offer in the system prompt is not a moment. The close of the turn is one, and it is the last
 * one there is — so it carries the check, while the instruction itself still says to write it when it is
 * learned. A run stopped early must still leave behind what it paid for.
 */
describe("what an implementer is asked before it stops", () => {
  const src = (f: string): Promise<string> => readFile(f, "utf8");

  it("asks whether anything cost more than one attempt, and to record it", async () => {
    const s = await src("src/engine/implementer.ts");
    expect(s).toContain("did anything here cost you more than one attempt");
    expect(s).toContain("remember_fact");
    expect(s).toContain("The next agent pays for it again otherwise.");
  });

  it("still tells every role holding the tool to write it AS it is learned", async () => {
    const s = await src("src/engine/task-types.ts");
    expect(s).toContain("A SECOND failure of the same kind is the trigger");
    expect(s).toContain("Write it before you carry on");
  });
});
