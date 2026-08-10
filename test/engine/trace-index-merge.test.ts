import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  mergeTraceIndexes, parseTraceIndex, serializeTraceIndex, setTraceRoot, traceRootRel, TRACE_INDEX,
  type TraceIndex,
} from "../../src/engine/trace.js";
import { resolveGeneratedConflicts, type ConflictDeps } from "../../src/engine/conflict.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import { WorktreeManager } from "../../src/worktree/manager.js";
import { initTmpRepo } from "../worktree/helpers.js";

const rec = (file: string, writtenAt: number, model = "m"): TraceIndex["traces"][string] =>
  ({ hash: `h-${file}-${writtenAt}`, file, writtenAt, model });
const index = (...entries: [string, number][]): TraceIndex =>
  ({ version: 1, traces: Object.fromEntries(entries.map(([f, t]) => [f, rec(f, t)])) });

describe("mergeTraceIndexes", () => {
  it("keeps both sides' entries — two branches trace the files they each changed", () => {
    const merged = mergeTraceIndexes(index(["a.ts", 1]), index(["b.ts", 2]));
    expect(Object.keys(merged.traces).sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("the newer trace of the same file wins — a trace is derived from the content it described", () => {
    const merged = mergeTraceIndexes(index(["a.ts", 10]), index(["a.ts", 20]));
    expect(merged.traces["a.ts"]!.hash).toBe("h-a.ts-20");
    const other = mergeTraceIndexes(index(["a.ts", 30]), index(["a.ts", 20]));
    expect(other.traces["a.ts"]!.hash).toBe("h-a.ts-30");
  });

  it("round-trips through the on-disk form the tracer itself writes", () => {
    const merged = mergeTraceIndexes(index(["a.ts", 1]), index(["b.ts", 2]));
    expect(parseTraceIndex(serializeTraceIndex(merged))).toEqual(merged);
  });

  it("refuses anything that is not an index rather than merging into garbage", () => {
    expect(parseTraceIndex("not json")).toBeUndefined();
    expect(parseTraceIndex('{"version":2,"traces":{}}')).toBeUndefined();
    expect(parseTraceIndex('{"version":1}')).toBeUndefined();
  });
});

let repo = "";
const originalRoot = traceRootRel();
afterEach(async () => {
  setTraceRoot(originalRoot);
  if (repo) await rm(repo, { recursive: true, force: true });
  repo = "";
});

describe("resolveGeneratedConflicts: the trace index", () => {
  it("combines both sides and stages it, so nobody merges machine-written JSON by hand", async () => {
    // The real case this was written for: 225 commits of a main branch merged into a session branch produced
    // exactly one conflict, and it was this file.
    setTraceRoot("docs/architecture");
    repo = await initTmpRepo();
    const mgr = new WorktreeManager({ repoRoot: repo });
    const rel = `${traceRootRel()}/${TRACE_INDEX}`;

    await mkdir(join(repo, traceRootRel()), { recursive: true });
    await writeFile(join(repo, rel), serializeTraceIndex(index(["seed.ts", 1])), "utf8");
    await defaultGitRunner(["add", "-A"], repo);
    await defaultGitRunner(["commit", "-m", "seed index"], repo);

    const session = await mgr.openSession("main", "job");
    await writeFile(join(session.baseWorktree, rel), serializeTraceIndex(index(["seed.ts", 1], ["session.ts", 5])), "utf8");
    await defaultGitRunner(["add", "-A"], session.baseWorktree);
    await defaultGitRunner(["commit", "-m", "session traced its file"], session.baseWorktree);

    await writeFile(join(repo, rel), serializeTraceIndex(index(["seed.ts", 1], ["main.ts", 7])), "utf8");
    await defaultGitRunner(["add", "-A"], repo);
    await defaultGitRunner(["commit", "-m", "main traced its file"], repo);

    const merge = await mgr.mergeRef(session, "main");
    expect(merge.status).toBe("conflict");

    const notes: string[] = [];
    const deps = { manager: mgr, note: (t: string) => { notes.push(t); } } as unknown as ConflictDeps;
    const { conflicted } = await resolveGeneratedConflicts(deps, session, await mgr.unmergedFiles(session));

    expect(conflicted).toEqual([]);            // nothing left for an agent to think about
    expect(await mgr.unmergedFiles(session)).toEqual([]); // …and it is staged, so the merge can be committed
    const onDisk = parseTraceIndex(await readFile(join(session.baseWorktree, rel), "utf8"))!;
    // Neither side lost its entries, which is what taking one side would have cost.
    expect(Object.keys(onDisk.traces).sort()).toEqual(["main.ts", "seed.ts", "session.ts"]);
    expect(notes.join(" ")).toContain("trace index");
  });
});
