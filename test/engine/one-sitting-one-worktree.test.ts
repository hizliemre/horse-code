import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-sit-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const src = async (f: string): Promise<string> =>
  (await import("node:fs/promises")).readFile(f, "utf8");

/**
 * Consecutive requests in one sitting are consecutive WORK.
 *
 * Every request used to cut its own worktree from `fromBranch`. Measured live: three sessions in eleven
 * minutes, and the second — smoke tests for a change the FIRST run had just made to the constitution — was
 * cut from `development` at exactly the commit the first had branched away from. Verified afterwards:
 * `hc/pr-677-smoke-tests-2/base` sat on `8c789088d`, the tip of development, and did not contain the
 * constitution commit at all. It could not see the work it was testing, and nothing on screen said so.
 *
 * A person does not re-clone the repository between two edits.
 */
describe("one sitting, one worktree", () => {
  it("takes the session it is already working in", async () => {
    const s = await src("src/engine/job.ts");
    const at = s.indexOf("const ensureWorktree =");
    const fn = s.slice(at, at + 2000);
    expect(fn).toContain("opts.continueIn");
    // Adopted after a possible rename — see test/worktree/rename-session.test.ts.
    expect(fn).toContain("adopt(renamed)");
  });

  /**
   * Checked against the filesystem, not trusted: a worktree the user removed between two requests would
   * otherwise be adopted as if it were still there, and every write would fail somewhere that is gone.
   */
  it("opens a fresh one when that worktree is no longer there", async () => {
    const s = await src("src/engine/job.ts");
    const at = s.indexOf("opts.continueIn && existsSync");
    expect(at).toBeGreaterThan(-1);
  });

  it("says which branch it is continuing in", async () => {
    const s = await src("src/engine/job.ts");
    const at = s.indexOf("adopt(renamed)");
    expect(s.slice(at, at + 400)).toMatch(/Continuing in/);
  });

  /** The handle travels back to the caller, or the next request has nothing to continue from. */
  it("hands the session back when one is opened", async () => {
    const job = await src("src/engine/job.ts");
    expect(job).toContain("deps.onSessionOpened?.(s)");
    const app = await src("src/tui/app.tsx");
    expect(app).toContain("onSessionOpened: (s) => { openSession.current = s; }");
    expect(app).toContain("continueIn: openSession.current");
  });

  /** A plain chat turn still opens nothing: the worktree is lazy, and that has not changed. */
  it("does not open one just because a sitting exists", async () => {
    const s = await src("src/engine/job.ts");
    const at = s.indexOf("const ensureWorktree =");
    // The adoption lives INSIDE ensureWorktree, which only runs when a phase needs to write.
    expect(s.slice(0, at)).not.toContain("opts.continueIn");
  });
});
