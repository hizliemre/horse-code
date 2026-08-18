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

/**
 * …and WHAT it put away, which the notice's headline number cannot say.
 *
 * Compaction is the suspect behind two costs measured on one run, and neither could be pinned on it from the
 * record. A planner re-read `spec.md` window after window — correct if its earlier reads had been put away,
 * waste if they had not. And `edit_file` failed with "no line of your oldString is in the file" 0 times in
 * its first 132 edits and 4 times in the last 54, which is what editing from a half-remembered file looks
 * like — but proving it needs the elided key beside the failing path.
 *
 * `hc.compact.freed: 46000` answers neither question. The keys do.
 */
describe("what a compaction records", () => {
  const src = readFileSync("src/agent/loop.ts", "utf8");

  it("names the calls it forgot, not only how many", () => {
    expect(src).toContain('telemetry().event("memory.compacted"');
    expect(src).toContain('"hc.compact.keys"');
    expect(src).toContain('"hc.compact.count": packed.forgotten.length');
  });

  it("is attributed, so a re-read can be matched to the agent that lost it", () => {
    const ev = src.slice(src.indexOf('"memory.compacted"'));
    expect(ev.slice(0, 600)).toContain('"hc.agent": agentId');
  });

  /** A run that forgets hundreds of calls must not turn one event into a copy of the conversation. */
  it("caps the list, while still reporting the true count", async () => {
    const { COMPACT_KEYS_LOGGED } = await import("../../src/agent/loop.js");
    expect(COMPACT_KEYS_LOGGED).toBeGreaterThan(0);
    expect(COMPACT_KEYS_LOGGED).toBeLessThanOrEqual(50);
    expect(src).toContain("packed.forgotten.slice(0, COMPACT_KEYS_LOGGED)");
  });

  it("reports it beside the notice, which is emitted at most once", () => {
    // The event is unconditional; the sentence to the user is the thing behind the latch.
    const latch = src.indexOf("if (!saidCompaction) {");
    const event = src.indexOf('telemetry().event("memory.compacted"');
    expect(event).toBeGreaterThan(latch);
  });
});
