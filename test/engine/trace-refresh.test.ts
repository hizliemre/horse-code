import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedByMerge, refreshTraces, describeRefresh } from "../../src/engine/trace-refresh.js";
import { planTraces, saveTrace, saveTraceIndex, loadTraceIndex, hashContent, tracePath } from "../../src/engine/trace.js";
import { runTraces } from "../../src/engine/trace-run.js";
import type { Provider } from "../../src/core/types.js";

const canned = (text: string): Provider => ({
  async *chat() { yield { type: "text-delta", text } as never; },
} as unknown as Provider);

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "refresh-")); await mkdir(join(cwd, "src"), { recursive: true }); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

const write = (p: string, t: string): Promise<void> => writeFile(join(cwd, p), t, "utf8");

describe("changedByMerge — the merge decides, not the implementer's report", () => {
  it("returns the diff between two refs, dropping files a trace could not describe", async () => {
    const git = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      expect(args).toEqual(["diff", "--name-only", "abc123..HEAD"]);
      return { code: 0, stdout: "src/a.ts\npackage-lock.json\nsrc/b.ts\n", stderr: "" };
    };
    expect(await changedByMerge(git, cwd, "abc123")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("says nothing rather than guessing when git fails or there is no baseline", async () => {
    const fail = async (): Promise<{ code: number; stdout: string; stderr: string }> => ({ code: 1, stdout: "", stderr: "boom" });
    expect(await changedByMerge(fail, cwd, "abc123")).toEqual([]);
    expect(await changedByMerge(fail, cwd, "")).toEqual([]);
  });
});

describe("refreshTraces — only what changed, and never at the cost of what did not", () => {
  /**
   * The one that would have been unrecoverable.
   *
   * `runTraces` prunes traces for every file NOT in `liveFiles`, which is right for a whole-repository run
   * and catastrophic for a partial one: a task that changed two files would have handed the pruner a
   * two-item list and had it delete the other two thousand traces, and their files off disk with them.
   */
  it("leaves the traces of untouched files completely alone", async () => {
    await write("src/a.ts", "changed code");
    await write("src/kept.ts", "untouched code");
    // A trace that exists for a file this refresh knows nothing about.
    await saveTrace(cwd, { file: "src/kept.ts", hash: hashContent("untouched code"), content: "untouched code", symbols: [], usedBy: [], uses: [] }, "Still true.", "m");
    await saveTraceIndex(cwd, { version: 1, traces: { "src/kept.ts": { hash: hashContent("untouched code"), file: "src/kept.ts", writtenAt: 1 } } });

    const plan = await planTraces(cwd, ["src/a.ts"], undefined, await loadTraceIndex(cwd));
    await runTraces({ cwd, provider: canned("A note about a."), model: "m", plan }); // no liveFiles → no pruning

    const after = await loadTraceIndex(cwd);
    expect(Object.keys(after.traces).sort()).toEqual(["src/a.ts", "src/kept.ts"]);
    expect(await readdir(join(cwd, ".horsecode", "traces", "src"))).toContain("kept.ts.md");
  });

  it("re-describes a file whose content moved on", async () => {
    await write("src/a.ts", "version two");
    await saveTrace(cwd, { file: "src/a.ts", hash: hashContent("version one"), content: "version one", symbols: [], usedBy: [], uses: [] }, "Describes version one.", "m");
    await saveTraceIndex(cwd, { version: 1, traces: { "src/a.ts": { hash: hashContent("version one"), file: "src/a.ts", writtenAt: 1 } } });

    const r = await refreshTraces({ cwd, files: ["src/a.ts"], provider: canned("Describes version two."), models: ["m"] });
    expect(r.traced).toBe(1);
    expect((await loadTraceIndex(cwd)).traces["src/a.ts"]?.hash).toBe(hashContent("version two"));
  });

  it("writes a trace for a file that did not exist before", async () => {
    await write("src/new.ts", "brand new code");
    const r = await refreshTraces({ cwd, files: ["src/new.ts"], provider: canned("A new thing."), models: ["m"] });
    expect(r.traced).toBe(1);
    expect(tracePath(cwd, "src/new.ts")).toContain("src/new.ts.md");
  });

  it("spends nothing on a file whose content is unchanged", async () => {
    await write("src/a.ts", "same");
    await saveTrace(cwd, { file: "src/a.ts", hash: hashContent("same"), content: "same", symbols: [], usedBy: [], uses: [] }, "Current.", "m");
    await saveTraceIndex(cwd, { version: 1, traces: { "src/a.ts": { hash: hashContent("same"), file: "src/a.ts", writtenAt: 1 } } });

    let called = false;
    const provider = { async *chat() { called = true; yield { type: "text-delta", text: "x" } as never; } } as unknown as Provider;
    const r = await refreshTraces({ cwd, files: ["src/a.ts"], provider, models: ["m"] });
    expect(called).toBe(false);
    expect(r.traced).toBe(0);
  });

  it("ignores files that are not trace subjects at all", async () => {
    await write("src/a.json", "{}");
    const r = await refreshTraces({ cwd, files: ["src/a.json", ".claude/x/y.ts"], provider: canned("x"), models: ["m"] });
    expect(r.traced).toBe(0);
    expect(r.skipped).toBe(2);
  });

  it("returns quietly with no tracer configured, rather than failing a merged task", async () => {
    await write("src/a.ts", "code");
    const r = await refreshTraces({ cwd, files: ["src/a.ts"], provider: canned("x"), models: [] });
    expect(r).toEqual({ traced: 0, failed: 0, removed: 0, skipped: 0 });
  });

  it("swallows a provider that throws — the work is already merged", async () => {
    await write("src/a.ts", "code");
    const boom = { async *chat() { throw new Error("rate limited"); } } as unknown as Provider;
    const r = await refreshTraces({ cwd, files: ["src/a.ts"], provider: boom, models: ["m"] });
    expect(r.failed).toBe(1);
    expect(r.traced).toBe(0);
  });
});

describe("refreshTraces — a deleted file's trace goes with it", () => {
  it("removes the trace of a file the task deleted, and leaves every other one", async () => {
    await write("src/kept.ts", "still here");
    await saveTrace(cwd, { file: "src/kept.ts", hash: hashContent("still here"), content: "still here", symbols: [], usedBy: [], uses: [] }, "Kept.", "m");
    await saveTrace(cwd, { file: "src/gone.ts", hash: "h", content: "x", symbols: [], usedBy: [], uses: [] }, "Describes a file that no longer exists.", "m");
    await saveTraceIndex(cwd, { version: 1, traces: {
      "src/kept.ts": { hash: hashContent("still here"), file: "src/kept.ts", writtenAt: 1 },
      "src/gone.ts": { hash: "h", file: "src/gone.ts", writtenAt: 1 },
    } });

    // The merge diff names the deleted file exactly as it names the added ones.
    const r = await refreshTraces({ cwd, files: ["src/gone.ts"], provider: canned("x"), models: ["m"] });
    expect(r.removed).toBe(1);
    expect(r.traced).toBe(0);

    const after = await loadTraceIndex(cwd);
    expect(Object.keys(after.traces)).toEqual(["src/kept.ts"]);
    expect(existsSync(tracePath(cwd, "src/gone.ts"))).toBe(false);
    expect(existsSync(tracePath(cwd, "src/kept.ts"))).toBe(true);
  });

  it("handles a rename — the old trace goes, the new file gets one", async () => {
    await write("src/new-name.ts", "moved code");
    await saveTrace(cwd, { file: "src/old-name.ts", hash: "h", content: "x", symbols: [], usedBy: [], uses: [] }, "Old.", "m");
    await saveTraceIndex(cwd, { version: 1, traces: { "src/old-name.ts": { hash: "h", file: "src/old-name.ts", writtenAt: 1 } } });

    const r = await refreshTraces({ cwd, files: ["src/old-name.ts", "src/new-name.ts"], provider: canned("Moved here."), models: ["m"] });
    expect({ removed: r.removed, traced: r.traced }).toEqual({ removed: 1, traced: 1 });
    const after = await loadTraceIndex(cwd);
    expect(Object.keys(after.traces)).toEqual(["src/new-name.ts"]);
  });
});

describe("describeRefresh", () => {
  it("says nothing when nothing happened", () => {
    expect(describeRefresh({ traced: 0, failed: 0, removed: 0, skipped: 4 })).toBeUndefined();
  });
  it("reports failures alongside successes", () => {
    expect(describeRefresh({ traced: 3, failed: 1, removed: 0, skipped: 0 })).toMatch(/3 trace\(s\) refreshed · 1 failed/);
  });
});
