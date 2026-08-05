import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCheckpoint, readCheckpoint } from "../../src/engine/checkpoint.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-lane-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const src = async (f: string): Promise<string> =>
  (await import("node:fs/promises")).readFile(f, "utf8");

/**
 * A lane that opens a worktree has to leave something to come back to.
 *
 * `verify` and `govern` return long before the pipeline's `writeCheckpoint` is ever called, so a run stopped
 * halfway left a worktree with the work in it and no marker beside it. Reported live: "devam" answered
 * "There is no preserved work to continue — no resumable worktree with a checkpoint was found in this
 * project" while `.horsecode/worktrees/pr-677-product-creation-testing/` sat there holding `base/` and
 * `tasks/` and nothing else.
 */
describe("continuing a lane that never reaches the pipeline", () => {
  it("writes a checkpoint from the lanes that open a worktree", async () => {
    const s = await src("src/engine/upstream.ts");
    expect(s).toContain('laneCheckpoint(cwd, "verify"');
    expect(s).toContain('laneCheckpoint(cwd, "govern"');
  });

  /** Working in place opens no session, so there is nothing to reopen — and no marker to mislead. */
  it("writes nothing when the lane worked in place", async () => {
    const s = await src("src/engine/upstream.ts");
    const fn = s.slice(s.indexOf("function laneCheckpoint"), s.indexOf("function laneCheckpoint") + 700);
    expect(fn).toContain("sessionBase(cwd)");
    expect(fn).toContain("if (root === undefined) return;");
  });

  /**
   * The resume has to go back to the LANE it came from. Both branches were guarded with `!resume`, so a
   * resumed verify fell through to a feature pipeline that had never been started.
   */
  it("re-enters the same lane on resume", async () => {
    const s = await src("src/engine/upstream.ts");
    expect(s).toContain('(!resume || resume.lane === "verify") && routeIntent(r.intent) === "verify"');
    expect(s).toContain('(!resume || resume.lane === "govern") && routeIntent(r.intent) === "govern"');
  });

  it("carries the lane through a round trip on disk", async () => {
    const root = join(dir, "session");
    await mkdir(root, { recursive: true });
    writeCheckpoint(root, {
      rawPrompt: "PR 677 testlerine devam", refinedPrompt: "continue the tests", title: "pr-677-tests",
      language: "Turkish", featureSlug: "", done: [], lane: "verify",
    });
    expect(readCheckpoint(root)?.lane).toBe("verify");
  });

  /** The key stays the ORIGINAL request: resuming must not re-key the worktree to the word "devam". */
  it("keeps the original request as the key across a resume", async () => {
    const s = await src("src/engine/upstream.ts");
    const fn = s.slice(s.indexOf("function laneCheckpoint"), s.indexOf("function laneCheckpoint") + 900);
    expect(fn).toContain("resume?.rawPrompt ?? prompt");
  });
});
