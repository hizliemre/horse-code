import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { traceDir, tracePath } from "../../src/engine/trace.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "hc-trace-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/**
 * Traces describe the code and belong to the run that produces them. A task worktree has none of its own and
 * must not reach past its session to the project root — the root is a reference, and nothing a run reads from
 * or writes to outside itself reaches the pull request. Same rule as the graph; traces were simply missed
 * when that was fixed, so a task looked for the project brief in its own empty directory.
 */
describe("traces are scoped to the session", () => {
  it("resolves a task worktree to its session base", async () => {
    const base = join(root, ".horsecode", "worktrees", "job-a", "base");
    const task = join(root, ".horsecode", "worktrees", "job-a", "tasks", "t1");
    await mkdir(task, { recursive: true });
    expect(traceDir(task)).toBe(join(base, ".horsecode", "traces"));
    expect(tracePath(task, "src/app.ts")).toBe(join(base, ".horsecode", "traces", "src/app.ts.md"));
  });

  it("keeps two concurrent sessions apart", async () => {
    const a = join(root, ".horsecode", "worktrees", "job-a", "tasks", "t1");
    const b = join(root, ".horsecode", "worktrees", "job-b", "tasks", "t1");
    expect(traceDir(a)).not.toBe(traceDir(b));
  });

  it("uses its own directory when there is no session — the REPL at the project root", () => {
    expect(traceDir(root)).toBe(join(root, ".horsecode", "traces"));
  });
});
