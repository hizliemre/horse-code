import { describe, it, expect } from "vitest";
import { describeDelivery } from "../../src/cli.js";
import type { Delivery } from "../../src/engine/wave-engine.js";

const base: Delivery = { branch: "hc/todo-app/base", worktree: "/repo/.horsecode/worktrees/todo-app" };

/**
 * The failure this guards against, observed on a real run: five and a half hours of work produced twenty-one
 * completed tasks, and the report said "Status: partial" and nothing else. The code was on a branch nobody
 * knew existed, the repository root was empty, and `npm install` could not be run. From outside, a finished
 * project that was never delivered is indistinguishable from one that was never built.
 */
describe("describeDelivery — the report always says where the code is", () => {
  it("says so plainly when the work reached the working copy", () => {
    const text = describeDelivery({ ...base, mergedInto: "main" });
    expect(text).toContain("Merged into `main`");
    expect(text).toMatch(/files are in your working copy/);
  });

  it("names the branch when it did not", () => {
    expect(describeDelivery(base)).toContain("hc/todo-app/base");
  });

  // A user who cannot see the code needs the command, not a description of the situation.
  it("gives the exact command to bring it in", () => {
    expect(describeDelivery(base)).toContain("git merge --no-ff hc/todo-app/base");
  });

  it("offers a way to look before merging", () => {
    const text = describeDelivery(base);
    expect(text).toContain("git diff HEAD...hc/todo-app/base");
    expect(text).toContain("/repo/.horsecode/worktrees/todo-app");
  });

  it("says WHY it was not merged, when there is a reason", () => {
    const text = describeDelivery({ ...base, notMerged: "the working copy has uncommitted changes" });
    expect(text).toMatch(/Not merged: the working copy has uncommitted changes/);
  });

  /** A partial run is not merged on purpose; the user still has to be able to reach the work that succeeded. */
  it("still points at the branch for a partial run", () => {
    const text = describeDelivery({ ...base, notMerged: "the run was partial" });
    expect(text).toContain("git merge --no-ff");
    expect(text).toContain("hc/todo-app/base");
  });
});
