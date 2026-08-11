import { describe, it, expect, vi, beforeEach } from "vitest";
import { verdictRule, directMessage, runMessage, resumeMessage } from "../../src/engine/verify.js";
import { buildReportFindingTool, FindingQueue, type Finding } from "../../src/engine/finding.js";
import type { Board } from "../../src/board/board.js";

/**
 * A step that does not pass is a defect to be fixed, not a word to write in a document.
 *
 * Measured live: the report was edited from `F4 — step-media (upload/reorder/delete) — **[PENDING]**` to
 * `**[FAILED]**`, three defects listed under it as OPEN, and the session went straight on to F5. Reported by
 * the user watching it: "testi düzeltmeden fixlemeden failed işaretleyip diğerine geçiyor. failed
 * işaretleyemeyiz!"
 *
 * Two things had told it to do exactly that. `report_finding` opened with "which is NOT the verdict of a
 * scenario" — written to stop routine outcomes becoming findings, read as an instruction to keep failures to
 * itself. And nothing anywhere said a scenario may not simply be failed.
 */
describe("a scenario is never closed as failed", () => {
  it("tells the tester the two endings a scenario has, and that this one is not its call", () => {
    expect(verdictRule).toMatch(/PASSES/);
    expect(verdictRule).toMatch(/report_finding/);
    expect(verdictRule).toMatch(/do not go on to another scenario until it passes/i);
    // …and the one exception, which belongs to the person paying for the session.
    expect(verdictRule).toMatch(/developer tells you to leave it/i);
  });

  it("carries the rule into every message the tester is ever handed", () => {
    const run = runMessage("check the wizard", "plan.md", "report.md", false);
    const direct = directMessage("check the wizard", "report.md");
    const resumed = resumeMessage("plan.md", "report.md", false, ["toast — FIXED"]);
    for (const m of [run, direct, resumed]) expect(m).toContain(verdictRule);
  });

  it("does not tell the tester, on the way back from a fix, to close what is still open", () => {
    const resumed = resumeMessage("plan.md", "report.md", false, ["drag preview — NOT fixed"]);
    expect(resumed).toMatch(/do not close a scenario as failed/i);
    expect(resumed).toMatch(/goes round again/i);
  });
});

describe("report_finding", () => {
  it("no longer excludes the one case that matters most — the scenario that failed", () => {
    const d = buildReportFindingTool(new FindingQueue()).description;
    expect(d).not.toMatch(/NOT the verdict of a scenario/i);
    expect(d).toMatch(/the reason a scenario does not pass/i);
    expect(d).toMatch(/one call per distinct defect/i);
    expect(d).toMatch(/you never fix it yourself/i);   // …the part that was right, kept
  });
});

/**
 * A first attempt that misses is the ordinary case, not a verdict.
 *
 * Three defects came back `NOT fixed` in the same session, nothing was tried again, and the tester wrote the
 * scenario off. The acceptance gate had just said in writing what was still not true — which is more than the
 * first attempt was ever given.
 */
const cycle = vi.hoisted(() => vi.fn());
vi.mock("../../src/engine/task-cycle.js", () => ({ runTaskCycle: cycle }));

const finding: Finding = {
  title: "drag preview grows to the photo's own size",
  detail: "While dragging, the preview is rendered at the original resolution instead of the card's.",
  files: ["src/media.ts"], acceptance: ["The preview keeps the card's size while dragging"], scenario: "F4",
};

describe("fixing a finding", () => {
  beforeEach(() => cycle.mockClear());

  it("tries again when the gate says it is still not true", async () => {
    const { runFix } = await import("../../src/engine/fix.js");
    cycle
      .mockResolvedValueOnce({ verdict: "fail", notes: ["the preview still uses the source dimensions"] })
      .mockResolvedValueOnce({ verdict: "pass", notes: [] });
    const r = await runFix({} as never, ".", finding);
    expect(r.fixed).toBe(true);
    expect(cycle).toHaveBeenCalledTimes(2);
  });

  it("hands the second attempt what the first was told, so it is not the same attempt twice", async () => {
    const { runFix } = await import("../../src/engine/fix.js");
    const boards: Board[] = [];
    const ids: string[] = [];
    cycle.mockImplementation((...a: unknown[]) => {
      boards.push(a[1] as Board);
      ids.push(a[2] as string);
      return Promise.resolve(boards.length === 1
        ? { verdict: "fail", notes: ["the preview still uses the source dimensions"] }
        : { verdict: "pass", notes: [] });
    });
    await runFix({} as never, ".", finding);
    expect(boards).toHaveLength(2);
    expect(boards[0]!.get(ids[0]!)!.reviewNotes).toEqual([]);   // nothing to answer for on the first try
    // …and the second is handed the gate's own words, on the channel a returning card already has.
    const note = boards[1]!.get(ids[1]!)!.reviewNotes.join(" ");
    expect(note).toContain("the preview still uses the source dimensions");
    expect(note).toMatch(/rather than making the same one again/i);
  });

  it("stops at two — a third is a conversation with the person sitting right there", async () => {
    const { runFix, FIX_ATTEMPTS } = await import("../../src/engine/fix.js");
    cycle.mockResolvedValue({ verdict: "fail", notes: ["still not true"] });
    const r = await runFix({} as never, ".", finding);
    expect(r.fixed).toBe(false);
    expect(cycle).toHaveBeenCalledTimes(FIX_ATTEMPTS);
    expect(r.notes).toContain("still not true");     // …and it says why, for the report
  });

  it("a fix that throws is still a fix that gets one more go, and never a thrown session", async () => {
    const { runFix } = await import("../../src/engine/fix.js");
    cycle
      .mockRejectedValueOnce(new Error("the model did not answer within its deadline"))
      .mockResolvedValueOnce({ verdict: "pass", notes: [] });
    await expect(runFix({} as never, ".", finding)).resolves.toMatchObject({ fixed: true });
  });
});
