import { describe, it, expect } from "vitest";
import { fixBeforeHandOff, MAX_FIX_ROUNDS } from "../../src/engine/verify.js";
import { FindingQueue, type Finding } from "../../src/engine/finding.js";

/**
 * A finding is fixed when the tester stops, not when the session does.
 *
 * `handleFindings` ran after `runTester` returned, and an interactive verification does not return for a long
 * time. Measured live: the tester reported "the upload size error shows no reason in the toast" at its 116th
 * tool call, handed over to the developer twice more and carried on; 181 calls later every one of them was
 * still `tester` and no fixer had run. The finding sat in an in-memory queue while the person was asked to go
 * on testing the product that still had it.
 */

const finding = (title: string): Finding =>
  ({ title, detail: "d", scenario: "F4", files: [], acceptance: [] });

describe("fixing at the hand-off", () => {
  it("fixes BEFORE the developer is sent off to test", async () => {
    const order: string[] = [];
    const q = new FindingQueue();
    q.add(finding("toast has no reason"));
    const ask = fixBeforeHandOff(
      async () => { order.push("asked"); return "ok"; },
      q,
      async () => { order.push("fixed"); return ["toast has no reason — FIXED"]; },
      { budget: { left: MAX_FIX_ROUNDS } },
    );
    await ask("go and click things");
    // The one part that cannot be automated must not be spent on a version we know is wrong.
    expect(order).toEqual(["fixed", "asked"]);
  });

  it("tells the developer the product changed under them", async () => {
    const q = new FindingQueue();
    q.add(finding("toast has no reason"));
    let seen = "";
    const ask = fixBeforeHandOff(
      async (question) => { seen = question; return "ok"; },
      q,
      async () => ["toast has no reason — FIXED"],
      { budget: { left: MAX_FIX_ROUNDS } },
    );
    await ask("go and click things");
    expect(seen).toMatch(/were dealt with/);
    expect(seen).toContain("toast has no reason — FIXED");
    expect(seen).toContain("go and click things");   // …and the original question survives
  });

  it("sends the tester back to the SAME step and holds it there until it passes", async () => {
    const q = new FindingQueue();
    q.add(finding("toast has no reason"));
    const ask = fixBeforeHandOff(
      async () => "the toast now says the size limit",
      q,
      async () => ["toast has no reason — FIXED"],
      { budget: { left: MAX_FIX_ROUNDS } },
    );
    const back = await ask("go and click things");
    expect(back).toContain("the toast now says the size limit");   // the answer itself is not lost
    expect(back).toMatch(/Re-run the step you just handed over/);
    expect(back).toMatch(/do not move on until it passes/);
    expect(back).toMatch(/Update each finding's own entry in the report/);
  });

  it("stays out of the way when nothing was reported", async () => {
    let fixes = 0;
    const ask = fixBeforeHandOff(
      async (q) => `answer to ${q}`,
      new FindingQueue(),
      async () => { fixes++; return []; },
      { budget: { left: MAX_FIX_ROUNDS } },
    );
    expect(await ask("plain question")).toBe("answer to plain question");
    expect(fixes).toBe(0);
  });

  it("hands the findings back when the budget is spent, instead of dropping them", async () => {
    const q = new FindingQueue();
    q.add(finding("one"));
    let fixes = 0;
    const ask = fixBeforeHandOff(
      async () => "ok", q,
      async () => { fixes++; return []; },
      { budget: { left: 0 } },
    );
    await ask("question");
    expect(fixes).toBe(0);
    // Put back, so the end-of-session round still sees them — a spent budget must not lose a finding.
    expect(q.drain().map((f) => f.title)).toEqual(["one"]);
  });

  it("spends the budget it uses, so hand-off and end-of-session cannot each have the full ceiling", async () => {
    const q = new FindingQueue();
    const budget = { left: 2 };
    const ask = fixBeforeHandOff(async () => "ok", q, async () => [], { budget });
    q.add(finding("a"));
    await ask("q1");
    expect(budget.left).toBe(1);
    q.add(finding("b"));
    await ask("q2");
    expect(budget.left).toBe(0);
  });
});
