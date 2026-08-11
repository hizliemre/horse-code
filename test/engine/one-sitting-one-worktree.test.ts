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
    const at = s.indexOf("const workingIn = ()");
    const fn = s.slice(at, at + 1200);
    expect(fn).toContain("opts.continueIn");
    expect(fn).toContain("adopt(opts.continueIn)");
    // …and the one call that opens a worktree asks it first, so it never opens a second one.
    expect(s.slice(s.indexOf("const ensureWorktree ="), s.indexOf("const ensureWorktree =") + 200))
      .toContain("workingIn();");
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
    const at = s.indexOf("adopt(opts.continueIn)");
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

  /**
   * A plain chat turn still opens nothing: the worktree is lazy, and that has not changed.
   *
   * The adoption moved OUT of `ensureWorktree` so the small-change path — which never calls it — could work
   * in the open session too. It stayed behind a function for exactly this reason: a chat turn calls neither,
   * so it adopts nothing, announces nothing and opens nothing.
   */
  it("does not open one just because a sitting exists", async () => {
    const s = await src("src/engine/job.ts");
    // Nothing adopts at the top level: every mention is inside `workingIn`, or is the call to it.
    const body = s.slice(s.indexOf("): Promise<JobResult> {"), s.indexOf("const workingIn = ()"));
    expect(body).not.toContain("opts.continueIn");
    // …and the small-change path reaches it only through the caller it is handed.
    expect(await src("src/engine/upstream.ts")).toContain("const cwd = workingIn?.() ?? process.cwd();");
  });
});
