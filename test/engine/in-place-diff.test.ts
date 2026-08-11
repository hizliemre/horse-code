import { describe, it, expect } from "vitest";
import { diffSince, workingTreeDiff, MAX_DIFF_CHARS } from "../../src/engine/task-diff.js";
import type { GitRunner } from "../../src/worktree/git.js";
import { readFile } from "node:fs/promises";

/**
 * The review was handed the wrong diff, and it cost the entire run.
 *
 * Measured live: a coder fixed the drag preview in the product wizard. Every file an implementer writes is
 * auto-committed as a `wip(…)` checkpoint — that is what lets a killed attempt keep its work — so the fix
 * went into five commits and the working tree was left holding one line of `.horsecode/memory.jsonl`.
 *
 * The review asked `git diff HEAD`. `code-plan-conformance` read exactly what it was given and rejected:
 * "the working-tree diff contains only bookkeeping changes in .horsecode/memory.jsonl; it does not modify the
 * step-2 product-creation wizard". The council voted 5/5 to send it back, and the run closed with "Nothing
 * was committed" printed above five commits sitting in the log. 22 minutes, 148 calls, nothing kept.
 */
const runner = (calls: string[][], stdout = "diff --git a/x b/x"): GitRunner =>
  (async (args: string[]) => { calls.push(args); return { code: 0, stdout, stderr: "" }; }) as unknown as GitRunner;

describe("the diff of work done in place", () => {
  it("measures from where the task started, so the auto-commits are in it", async () => {
    const calls: string[][] = [];
    await diffSince("/w", "abc123", runner(calls));
    expect(calls[0]!.slice(0, 2)).toEqual(["diff", "abc123"]);
  });

  it("uses two dots, not three — the uncommitted tree is part of the change too", async () => {
    const calls: string[][] = [];
    await diffSince("/w", "abc123", runner(calls));
    expect(calls[0]!.join(" ")).not.toContain("...");
  });

  it("is not workingTreeDiff, which asks HEAD and gets nothing once the work is committed", async () => {
    const calls: string[][] = [];
    await workingTreeDiff("/w", runner(calls));
    expect(calls[0]!.slice(0, 2)).toEqual(["diff", "HEAD"]);   // …the question that came back empty
  });

  it("truncates like every other diff — it rides in the prompt of every review round", async () => {
    const big = "x".repeat(MAX_DIFF_CHARS + 500);
    const out = await diffSince("/w", "abc123", runner([], big));
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain("diff truncated");
  });

  it("says nothing rather than something wrong when git fails", async () => {
    const fail = (async () => ({ code: 128, stdout: "", stderr: "not a repo" })) as unknown as GitRunner;
    expect(await diffSince("/w", "abc123", fail)).toBe("");
  });
});

/**
 * The sha was already being taken — one line before the implementer runs — and simply not passed on.
 */
describe("who tells the review where the work started", () => {
  const src = (f: string): Promise<string> => readFile(f, "utf8");

  it("hands the review and the gate the point the work began from", async () => {
    const s = await src("src/engine/task-cycle.ts");
    expect(s).toContain('const startedAt = before?.split("|")[0];');
    expect(s).toContain("deps.baseRef || !startedAt ? deps : { ...deps, inPlaceBase: startedAt }");
    expect(s).toContain("runCodeReview(rdeps,");
    expect(s).toContain("verifyAcceptance(rdeps,");
  });

  it("asks the same question in one place, for the lenses, the council and the gate", async () => {
    const r = await src("src/engine/review.ts");
    expect(r).toContain("async function changeUnderReview(");
    expect(r).toContain("if (deps.inPlaceBase) return diffSince(workdir, deps.inPlaceBase);");
    // …and no call site is left asking it the old way.
    expect(r).not.toContain("deps.baseRef ? await taskDiff(workdir, deps.baseRef) : await workingTreeDiff");
    expect(await src("src/engine/acceptance.ts")).toContain("diffSince(cwd, deps.inPlaceBase)");
  });
});

/**
 * The one file guaranteed to be in every diff is the one file that is never the work.
 *
 * `excludeOwnState` was written for the PULL REQUEST diff, after PR #765 handed a reviewer 60,000 characters
 * holding exactly two files — `.gitignore` and `.horsecode/memory.jsonl` — while all 36 source files fell
 * outside the budget. The TASK diff, which every lens, the council and the acceptance gate read, went on
 * asking the same question the same way.
 *
 * Measured on the run that produced this test: the council approved the change 5/5, and then the acceptance
 * gate failed 6 of 6 criteria with "the diff visible in the prompt is entirely memory.jsonl metadata changes
 * (injection counters). The actual Angular/HTML template changes that this task requires were in the
 * truncated portion of the diff, and no source file was opened to verify." 31 minutes and 270 calls, thrown
 * away over a file the work never touched.
 */
describe("what a diff must never spend its budget on", () => {
  const call = async (fn: (g: GitRunner) => Promise<string>): Promise<string[]> => {
    const calls: string[][] = [];
    await fn(runner(calls));
    return calls[0]!;
  };

  it("leaves horse-code's own state out of the task diff", async () => {
    const args = await call((g) => diffSince("/w", "abc123", g));
    expect(args.join(" ")).toContain(":(exclude).horsecode/**");
  });

  it("…of the branch diff", async () => {
    const { taskDiff } = await import("../../src/engine/task-diff.js");
    const args = await call((g) => taskDiff("/w", "main", g));
    expect(args.join(" ")).toContain(":(exclude).horsecode/**");
    expect(args[1]).toBe("main...HEAD");   // …and still asks the same question
  });

  it("…and of the working-tree diff", async () => {
    const args = await call((g) => workingTreeDiff("/w", g));
    expect(args.join(" ")).toContain(":(exclude).horsecode/**");
  });

  it("excludes the generated graph and the traces too — same reason, same files", async () => {
    const args = (await call((g) => diffSince("/w", "abc123", g))).join(" ");
    expect(args).toContain(":(exclude)graphify-out/**");
  });
});
