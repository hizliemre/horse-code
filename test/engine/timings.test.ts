import { describe, it, expect } from "vitest";
import { Timings, describeTimings } from "../../src/engine/timings.js";

/** A clock the test drives, so the assertions are about the accounting and not about how fast a machine is. */
const clock = (): { now: () => number; tick: (ms: number) => void } => {
  let t = 0;
  return { now: () => t, tick: (ms) => { t += ms; } };
};

/**
 * Every "why is this slow" answer so far was inferred from failure COUNTS on the board, because nothing
 * recorded seconds. That reasoning kept pointing at the right area and could never rank two candidates: a
 * stage that fails often and a stage that is simply slow look identical in a counter.
 */
describe("Timings", () => {
  it("accumulates a stage across every task that ran it", async () => {
    const c = clock();
    const t = new Timings(c.now);
    await t.time("code review", async () => { c.tick(4_000); });
    await t.time("code review", async () => { c.tick(6_000); });
    expect(t.summary()).toEqual([{ stage: "code review", ms: 10_000, n: 2 }]);
  });

  /** A stage that fails still consumed the time — and those are exactly the ones worth seeing. */
  it("records a stage that threw", async () => {
    const c = clock();
    const t = new Timings(c.now);
    await expect(t.time("implementation", async () => { c.tick(20_000); throw new Error("budget"); }))
      .rejects.toThrow("budget");
    expect(t.summary()[0]).toEqual({ stage: "implementation", ms: 20_000, n: 1 });
  });

  it("puts the heaviest stage first — that is the one to attack", async () => {
    const c = clock();
    const t = new Timings(c.now);
    await t.time("git", async () => { c.tick(1_000); });
    await t.time("test suite", async () => { c.tick(30_000); });
    await t.time("code review", async () => { c.tick(9_000); });
    expect(t.summary().map((r) => r.stage)).toEqual(["test suite", "code review", "git"]);
  });

  it("is empty until something is measured", () => {
    expect(new Timings().empty).toBe(true);
  });
});

describe("describeTimings", () => {
  const filled = (): Timings => {
    const t = new Timings();
    t.record("implementation", 600_000);
    t.record("implementation", 600_000);
    t.record("test suite", 300_000);
    t.record("code review", 90_000);
    t.record("git", 2_000);
    return t;
  };

  it("names each stage with its share and how often it ran", () => {
    const line = describeTimings(filled());
    expect(line).toContain("implementation 20m");
    expect(line).toMatch(/implementation 20m \(75% · 2×\)/);
    expect(line).toContain("test suite 5m");
  });

  /** Sums are SLOT time — several tasks run at once, so the total legitimately exceeds the wall clock. */
  it("says the measure is slot time, not how long the run took", () => {
    expect(describeTimings(filled())).toMatch(/Slot time/);
  });

  it("drops a stage too small to matter in a report about where time goes", () => {
    expect(describeTimings(filled())).not.toContain("git");
  });

  it("says nothing at all when nothing was measured", () => {
    expect(describeTimings(new Timings())).toBe("");
  });
});
