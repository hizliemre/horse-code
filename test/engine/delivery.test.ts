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
  it("names the branch the work is on", () => {
    expect(describeDelivery(base)).toContain("hc/todo-app/base");
  });

  /**
   * There is no "merged into your branch" outcome any more, and the report must not imply one.
   *
   * A run used to merge into the branch the job started from when there was no remote to open a pull request
   * against. Reported live: it landed in the project's own `development` and had to be undone by hand. The
   * checkout the user is standing in is the one place a run never writes, so the report is now the delivery
   * in every case — never a consolation for a merge that did not happen.
   */
  it("never claims the work reached the working copy", () => {
    expect(describeDelivery(base)).not.toMatch(/Merged into/);
    expect(describeDelivery(base)).toContain("not in your working copy yet");
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

  /** A partial run still built something; the user has to be able to reach the work that succeeded. */
  it("points at the branch whatever the run's status was", () => {
    const text = describeDelivery(base);
    expect(text).toContain("git merge --no-ff");
    expect(text).toContain("hc/todo-app/base");
  });
});
