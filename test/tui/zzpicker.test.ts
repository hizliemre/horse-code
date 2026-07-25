import { describe, it, expect } from "vitest";
import { TuiController } from "../../src/tui/controller.js";

// A picker is an OVERLAY, not the end of the turn. `/mode auto` is exactly the thing a user reaches for WHILE
// a job is running (to stop the approval prompts), and closing it used to hard-reset the controller to
// "input" — tearing the status line off a job that was still working, for the rest of the run.
describe("a picker used mid-job does not end the job's status line", () => {
  const running = (): TuiController => {
    const c = new TuiController();
    c.startBusy("coding", "cc/claude-sonnet-5");
    return c;
  };

  it("/mode keeps the run alive after applying", () => {
    const c = running();
    c.openModePicker(["auto", "ask"], "note");
    expect(c.getState().mode).toBe("picker");
    c.applyMode("auto", "auto-approve everything except dangerous commands");
    expect(c.getState().mode).toBe("running"); // the shimmer stays
    expect(c.getState().meta?.running).toBe(true);
  });

  it("cancelling a picker mid-job also returns to running", () => {
    const c = running();
    c.openModePicker(["auto"], "note");
    c.cancelPicker();
    expect(c.getState().mode).toBe("running");
  });

  it("the same holds for /model and /roles setmodel", () => {
    const c = running();
    c.applyModel("cc/claude-opus-4-8");
    expect(c.getState().mode).toBe("running");
    c.applyRoleModel("coder", ["a/m1", "b/m2"]);
    expect(c.getState().mode).toBe("running");
  });

  it("still returns to input when NO job is running (the ordinary case is unchanged)", () => {
    const c = new TuiController();
    c.openModePicker(["auto"], "note");
    c.applyMode("auto", "d");
    expect(c.getState().mode).toBe("input");
  });

  it("returns to input once the job has finished", () => {
    const c = running();
    c.endBusy();
    c.applyMode("auto", "d");
    expect(c.getState().mode).toBe("input");
  });

  it("the mode change is still confirmed in the transcript", () => {
    const c = running();
    c.applyMode("auto", "auto-approve everything except dangerous commands");
    const last = c.getState().transcript.at(-1);
    expect(last && "text" in last ? last.text : "").toContain("auto");
  });
});
