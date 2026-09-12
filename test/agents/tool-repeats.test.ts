import { describe, it, expect } from "vitest";
import { RepeatWatch, callKey, describeRepeats } from "../../src/agents/tool-repeats.js";

/**
 * `recall.ts` exists because of a measurement: over one 577-minute run, 1,141 of 6,743 reads and searches
 * were literal repeats inside a single agent's own conversation — one in six, with one agent spending 113 of
 * its 300 calls that way. On the delegated path the tool loop belongs to the CLI, so `recall` cannot see it.
 * This counts what it can no longer prevent.
 */
describe("counting a delegated agent's repeated questions", () => {
  const watch = (calls: { name: string; target?: string }[]) => {
    const w = new RepeatWatch();
    for (const c of calls) w.add(c);
    return w.report();
  };

  it("counts the second and later asks, never the first", () => {
    const r = watch([
      { name: "read_file", target: "a.ts" },
      { name: "read_file", target: "a.ts" },
      { name: "read_file", target: "a.ts" },
    ]);
    expect(r.calls).toBe(3);
    expect(r.repeats).toBe(2);
    expect(r.worst[0]).toEqual({ key: "read_file:a.ts", times: 3 });
  });

  /** Neither half alone is the question: different files are different questions, and so are different tools. */
  it("does not call two different questions a repeat", () => {
    expect(watch([
      { name: "read_file", target: "a.ts" },
      { name: "read_file", target: "b.ts" },
      { name: "grep", target: "a.ts" },
    ]).repeats).toBe(0);
  });

  /**
   * A call the stream did not name a target for cannot be compared. Counted, never matched — treating every
   * unnamed call as identical would report a long agent as almost entirely repetition.
   */
  it("counts an unnamed call without matching it against others", () => {
    const r = watch([{ name: "bash" }, { name: "bash" }, { name: "bash" }]);
    expect(r.calls).toBe(3);
    expect(r.repeats).toBe(0);
    expect(callKey({ name: "bash" })).toBeUndefined();
  });

  it("names the worst offenders, most-repeated first", () => {
    const r = watch([
      ...Array(4).fill({ name: "glob", target: "**/*.spec.ts" }),
      ...Array(2).fill({ name: "read_file", target: "project.json" }),
    ]);
    expect(r.worst.map((w) => w.key)).toEqual(["glob:**/*.spec.ts", "read_file:project.json"]);
  });

  it("says nothing at all when nothing repeated", () => {
    expect(describeRepeats(watch([{ name: "read_file", target: "a.ts" }]))).toBeUndefined();
  });

  it("reports the share, because the count alone does not say whether it matters", () => {
    const line = describeRepeats(watch([
      { name: "read_file", target: "a.ts" }, { name: "read_file", target: "a.ts" },
      { name: "grep", target: "b.ts" }, { name: "glob", target: "c" },
    ]));
    expect(line).toMatch(/1 of 4/);
    expect(line).toMatch(/25%/);
    expect(line).toContain("read_file:a.ts ×2");
  });
});
