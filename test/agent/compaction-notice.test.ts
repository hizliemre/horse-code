import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The housekeeping notice is said once, not once per turn.
 *
 * Past the threshold every turn compacts, and every turn re-printed the same sentence with a different
 * number in it. Reported from a real screen: eleven of them in one view, one under each "Ran N calls" line —
 * the account of what the agent actually did was buried under repetitions of a notice about bookkeeping.
 *
 * A source check rather than a run: the behaviour is a latch around one emit, and driving a real agent past
 * MAX_CONVERSATION_CHARS twice to observe it would test the compactor, not the latch.
 */
describe("the compaction notice", () => {
  const src = readFileSync("src/agent/loop.ts", "utf8");

  it("is guarded by a latch that starts closed", () => {
    expect(src).toContain("let saidCompaction = false;");
    expect(src).toContain("if (!saidCompaction) {");
    expect(src).toContain("saidCompaction = true;");
  });

  it("sets the latch before speaking, so a throw cannot re-open it", () => {
    const set = src.indexOf("saidCompaction = true;");
    const say = src.indexOf("📦 Put away");
    expect(set).toBeGreaterThan(0);
    expect(say).toBeGreaterThan(set);
  });

  it("says that it keeps happening, so silence afterwards is not a surprise", () => {
    expect(src).toContain("This continues quietly");
  });

  it("keeps the latch per agent run, not per module — two agents each explain themselves once", () => {
    // Declared inside the generator, after the chain index: a module-level flag would silence the notice for
    // every later agent in the process, including ones a user has not seen compact at all.
    const decl = src.indexOf("let saidCompaction = false;");
    const loopStart = src.indexOf("let chainIdx = 0;");
    expect(decl).toBeGreaterThan(loopStart);
  });
});
