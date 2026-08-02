import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  snapshot, recordTurn, lastTurn, clearTurn, undoTurn, describeUndo, describeForContext,
  MAX_SNAPSHOT_FILES,
} from "../../src/engine/turn-effect.js";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "turn-")); await mkdir(join(cwd, ".specify", "memory"), { recursive: true }); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

const CONST = join(".specify", "memory", "constitution.md");
const put = (rel: string, body: string): Promise<void> => writeFile(join(cwd, rel), body, "utf8");

describe("the reported failure, end to end", () => {
  /**
   * A constitution was updated wrongly; the next prompt said "undo your changes, go back to the previous
   * version"; the run wrote a THIRD constitution. Nothing was wrong with the model's reading of the
   * sentence — the sentence had no referent, because only the transcript's TEXT crossed the turn boundary.
   */
  it("puts the file back exactly as it was", async () => {
    await put(CONST, "# Constitution v1.0.0\nThe original principles.\n");

    // The turn: snapshot before, write after — the order that makes an undo exact rather than a re-derivation.
    const before = await snapshot(cwd, CONST);
    await put(CONST, "# Constitution v2.0.0\nThe wrong rewrite.\n");
    await recordTurn(cwd, { prompt: "tighten the constitution", kind: "in-place", files: [before], unsnapshotted: [] });

    const res = await undoTurn(cwd, await lastTurn(cwd));
    expect(res.restored).toEqual([CONST]);
    expect(await readFile(join(cwd, CONST), "utf8")).toBe("# Constitution v1.0.0\nThe original principles.\n");
  });

  it("tells the NEXT turn what the previous one did, which is what was missing", async () => {
    await put(CONST, "original");
    const before = await snapshot(cwd, CONST);
    await put(CONST, "rewritten");
    await recordTurn(cwd, { prompt: "tighten the constitution", kind: "in-place", files: [before], unsnapshotted: [] });

    const ctx = describeForContext(await lastTurn(cwd));
    expect(ctx).toContain(CONST);
    expect(ctx).toContain("tighten the constitution");
    expect(ctx).toMatch(/undo|revert/i); // …and says the words point at THESE files
  });

  it("removes a file the turn created — 'nothing was here' is a previous state too", async () => {
    const before = await snapshot(cwd, CONST); // does not exist yet
    expect(before.created).toBe(true);
    await put(CONST, "# brand new");
    await recordTurn(cwd, { prompt: "write the constitution", kind: "in-place", files: [before], unsnapshotted: [] });

    const res = await undoTurn(cwd, await lastTurn(cwd));
    expect(res.removed).toEqual([CONST]);
    expect(existsSync(join(cwd, CONST))).toBe(false);
  });

  it("cannot be undone twice — the second attempt has nothing to act on", async () => {
    await put(CONST, "original");
    const before = await snapshot(cwd, CONST);
    await put(CONST, "rewritten");
    await recordTurn(cwd, { prompt: "x", kind: "in-place", files: [before], unsnapshotted: [] });

    expect((await undoTurn(cwd, await lastTurn(cwd))).restored).toEqual([CONST]);
    await clearTurn(cwd);
    const second = await undoTurn(cwd, await lastTurn(cwd));
    expect(second.refused).toBeTruthy();
    expect(await readFile(join(cwd, CONST), "utf8")).toBe("original"); // and did not re-apply anything
  });
});

describe("what undo refuses to do", () => {
  /**
   * A pipeline run never overwrote anything in the working tree — it built on a branch. Dropping someone's
   * branch because a sentence was read as "undo" is not a favour, and a silent refusal is worse than a
   * stated one.
   */
  it("will not touch branch work, and says so by name", async () => {
    await recordTurn(cwd, { prompt: "add login", kind: "branch", files: [], unsnapshotted: [], branch: "hc/job/login" });
    const res = await undoTurn(cwd, await lastTurn(cwd));
    expect(res.restored).toEqual([]);
    expect(res.refused).toContain("hc/job/login");
    expect(describeUndo(res)).toContain("hc/job/login");
  });

  it("says plainly when there is nothing recorded", async () => {
    const res = await undoTurn(cwd, await lastTurn(cwd));
    expect(res.refused).toMatch(/nothing recorded/i);
  });

  it("reports a file it could not snapshot instead of pretending it restored it", async () => {
    await put(CONST, "current");
    await recordTurn(cwd, { prompt: "x", kind: "in-place", files: [{ file: CONST, created: false }], unsnapshotted: [] });
    const res = await undoTurn(cwd, await lastTurn(cwd));
    expect(res.restored).toEqual([]);
    expect(res.failed[0]?.error).toMatch(/too large/);
    expect(await readFile(join(cwd, CONST), "utf8")).toBe("current"); // untouched, not blanked
  });
});

describe("the record never becomes a second copy of the repository", () => {
  it("bounds how many files it snapshots and names what it dropped", async () => {
    const files = Array.from({ length: MAX_SNAPSHOT_FILES + 3 }, (_, i) => ({ file: `src/f${i}.ts`, created: true }));
    await recordTurn(cwd, { prompt: "x", kind: "in-place", files, unsnapshotted: [] });
    const rec = await lastTurn(cwd);
    expect(rec?.files.length).toBe(MAX_SNAPSHOT_FILES);
    expect(rec?.unsnapshotted).toEqual(["src/f40.ts", "src/f41.ts", "src/f42.ts"]);
  });

  it("does not snapshot a file bigger than the ceiling — the record stays a record", async () => {
    await put("big.txt", "x".repeat(600_000));
    const s = await snapshot(cwd, "big.txt");
    expect(s.before).toBeUndefined();
    expect(s.created).toBe(false);
  });
});
