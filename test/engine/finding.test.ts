import { describe, it, expect } from "vitest";
import { FindingQueue, buildReportFindingTool, describeFindings, type Finding } from "../../src/engine/finding.js";
import { cardFromFinding, describeFix } from "../../src/engine/fix.js";
import { describeEscalation } from "../../src/engine/triage.js";

const ctx = (): unknown => ({ cwd: ".", signal: new AbortController().signal });
const F: Finding = {
  title: "Summary screen omits the Product Description label",
  detail: "On the summary step the description is rendered as raw markdown and its label is missing.",
  files: ["src/summary.ts"],
  acceptance: ["The summary shows a Product Description label", "The description renders as formatted text"],
  scenario: "F2",
};

/**
 * A finding is not a scenario's verdict.
 *
 * Reported from a live session: "burada aslında testi tamamlamıyorum, test esnasında farkettiğim bulguyu
 * söylüyorum". Recording that as FAILED would be two lies at once — the scenario was never run to
 * completion, and the thing that is wrong is not what the scenario was asking about.
 */
describe("reporting something noticed in passing", () => {
  it("records it and tells the tester exactly what NOT to do about it", async () => {
    const q = new FindingQueue();
    const tool = buildReportFindingTool(q);
    const res = await tool.run(F, ctx() as never);
    expect(res.isError).toBe(false);
    expect(q.length).toBe(1);
    expect(res.content).toMatch(/do not fix it yourself/i);
    expect(res.content).toMatch(/do not mark the scenario failed/i);
    expect(res.content).toMatch(/#1/);
  });

  it("is a safe tool — recording what you saw must never stop for approval", () => {
    expect(buildReportFindingTool(new FindingQueue()).permissionLevel).toBe("safe");
  });

  it("hands each finding out once, so a resumed loop does not re-fix what it fixed", () => {
    const q = new FindingQueue();
    q.add(F);
    expect(q.drain()).toHaveLength(1);
    expect(q.drain()).toHaveLength(0);
    q.add({ ...F, title: "another" });
    expect(q.drain().map((f) => f.title)).toEqual(["another"]);
    expect(q.all()).toHaveLength(2);   // …while the report still shows both
  });

  it("shows findings apart from the scenario results, and says why they are apart", () => {
    const text = describeFindings([F]);
    expect(text).toContain("## Findings");
    expect(text).toMatch(/not the verdict of any scenario/i);
    expect(text).toContain("F2");
    expect(describeFindings([])).toBe("");
  });
});

describe("a finding becomes a card", () => {
  it("carries its own acceptance criteria across", () => {
    const c = cardFromFinding(F, "fix-1");
    expect(c.title).toBe(F.title);
    expect(c.acceptance).toEqual(F.acceptance);
    expect(c.files).toEqual(["src/summary.ts"]);
  });

  /**
   * The gate can only check what it was given. A finding reported without criteria would otherwise pass by
   * having been attempted — and what the person actually SAW is the one statement always true of a real fix.
   */
  it("never leaves the acceptance gate with nothing to check", () => {
    const c = cardFromFinding({ ...F, acceptance: [] }, "fix-1");
    expect(c.acceptance).toHaveLength(1);
    expect(c.acceptance[0]).toContain(F.detail);
  });
});

describe("what the user is told", () => {
  it("names the finding and what the fix went through", () => {
    expect(describeFix({ title: "X", fixed: true, notes: [] })).toMatch(/reviewed/i);
    const bad = describeFix({ title: "X", fixed: false, notes: ["nothing was written"] });
    expect(bad).toMatch(/not fixed/i);
    expect(bad).toMatch(/stays in the report/i);   // …and is not silently lost
  });

  /** Escalating costs the user their test session, so the ask says what it is and why. */
  it("says what a bigger finding would cost before spending it", () => {
    const brainstorm = describeEscalation(F, { depth: "brainstorm", reason: "there are two reasonable designs" });
    expect(brainstorm).toContain(F.title);
    expect(brainstorm).toContain("two reasonable designs");
    expect(brainstorm).toMatch(/decide the approach with you/i);
    const full = describeEscalation(F, { depth: "full", reason: "the capability was never built" });
    expect(full).toMatch(/spec and a plan/i);
  });
});
