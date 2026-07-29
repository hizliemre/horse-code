import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutex, mapWithLimit, runReady, runWaveEngine, runWaves } from "../../src/engine/wave-engine.js";
import type { WaveEngineDeps } from "../../src/engine/wave-engine.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import type { AskHuman } from "../../src/engine/escalation.js";
import { WorktreeManager } from "../../src/worktree/manager.js";
import type { WorktreeSession, PRAdapter } from "../../src/worktree/manager.js";
import { initTmpRepo } from "../worktree/helpers.js";
import type { RoleConfig } from "../../src/config/config.js";
import { Board } from "../../src/board/board.js";
import { Timings } from "../../src/engine/timings.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { Provider } from "../../src/core/types.js";
import { reviewBodies } from "../support/review-bodies.js";
import { fakeSpecKit } from "../support/fake-speckit.js";

// Content-based deterministic provider: responds based on the system prompt (role) + the task title in the message.
function engineProvider(failTasks: string[] = []): Provider {
  return {
    async *chat(req) {
      const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      const convo = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      const emitSubmit = function* (args: string) {
        yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: args } } as const;
        yield { type: "done", finishReason: "tool_calls" } as const;
      };
      if (sys.includes("P-router")) { yield* emitSubmit('{"role":"coder"}'); return; }
      if (sys.includes("P-architect")) { yield* emitSubmit('{"rootCause":"x","plan":["y"]}'); return; }
      if (sys.includes("P-reviewer")) {
        const fail = failTasks.some((t) => convo.includes(t));
        yield* emitSubmit(fail ? '{"verdict":"fail","notes":["nope"]}' : '{"verdict":"pass","notes":[]}');
        return;
      }
      // coder / senior / team-lead / other → no-op (no submit)
      yield { type: "text-delta", text: "ok" };
      yield { type: "done", finishReason: "stop" };
    },
  };
}

function fakeAdapter(): PRAdapter & { calls: number } {
  const a = { calls: 0, async createPR() { a.calls++; return { url: "http://pr/1", number: 1 }; } };
  return a;
}

interface EOpts { failTasks?: string[]; askHuman?: AskHuman; signal?: AbortSignal; rounds?: number }
function edeps(mgr: WorktreeManager, prAdapter: PRAdapter, opts: EOpts = {}): WaveEngineDeps {
  const roles: Record<string, RoleConfig> = {
    router: { models: ["m"], systemPrompt: "P-router" },
    coder: { models: ["m"], systemPrompt: "P-coder" },
    "senior-coder": { models: ["m"], systemPrompt: "P-senior-coder" },
    architect: { models: ["m"], systemPrompt: "P-architect" },
    "code-reviewer": { models: ["m"], systemPrompt: "P-reviewer" },
    "team-lead": { models: ["m"], systemPrompt: "P-teamlead" },
  };
  return {
    provider: engineProvider(opts.failTasks),
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: opts.signal ?? new AbortController().signal,
    specKit: fakeSpecKit,
    ...reviewBodies(),
    rounds: opts.rounds ?? 1,
    askHuman: opts.askHuman ?? (async () => ({ action: "abandon" })),
    manager: mgr,
    prAdapter,
  };
}

describe("createMutex", () => {
  it("concurrent calls run sequentially (no overlap)", async () => {
    const ser = createMutex();
    const order: string[] = [];
    const mk = (id: string, ms: number) => ser(async () => {
      order.push(`${id}-start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${id}-end`);
      return id;
    });
    const [a, b] = await Promise.all([mk("a", 20), mk("b", 5)]);
    expect([a, b]).toEqual(["a", "b"]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });
});

/**
 * A wave used to start every runnable task at once, with no ceiling — a twenty-task wave meant twenty agents,
 * each with its own worktree and history. Two heap exhaustions were reached that way.
 */
describe("mapWithLimit", () => {
  it("never runs more than the limit at once", async () => {
    let live = 0, peak = 0;
    await mapWithLimit([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
    });
    expect(peak).toBe(3);
  });

  it("returns results in the original order, not completion order", async () => {
    const out = await mapWithLimit([30, 5, 20, 1], 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3]);
  });

  it("passes each item its own index — the slot a task's model rotation is keyed to", async () => {
    expect(await mapWithLimit(["a", "b", "c"], 2, async (x, i) => `${x}${i}`)).toEqual(["a0", "b1", "c2"]);
  });

  it("still runs when there are fewer items than the limit", async () => {
    expect(await mapWithLimit([1], 8, async (x) => x * 2)).toEqual([2]);
  });

  it("an empty list is not an error", async () => {
    expect(await mapWithLimit([], 4, async () => 1)).toEqual([]);
  });

  /** A limit of zero would spawn no workers at all and hang forever. */
  it("treats a limit below one as one", async () => {
    expect(await mapWithLimit([1, 2], 0, async (x) => x)).toEqual([1, 2]);
  });
});

/**
 * The engine used to run strict layers: every task of wave N had to finish before ANY task of wave N+1
 * could start. On a real 94-task board that is 17 layers, and it sat with 63 tasks in TODO and ONE agent
 * running — that agent was the last unfinished task of layer 5, and the seventeen tasks of layer 6 were not
 * allowed to begin. A layer is an artefact of how the schedule was computed; what constrains a task is what
 * it depends on.
 */
describe("runReady", () => {
  /** Counts how many tasks are actually in flight: derive starts one, merge ends it. */
  const watched = (mgr: WorktreeManager): { mgr: WorktreeManager; peak: () => number } => {
    let live = 0, peak = 0;
    const wrapped = Object.create(mgr) as WorktreeManager;
    wrapped.deriveTask = async (...a: Parameters<WorktreeManager["deriveTask"]>) => {
      const r = await mgr.deriveTask(...a); live++; peak = Math.max(peak, live); return r;
    };
    wrapped.mergeTask = async (...a: Parameters<WorktreeManager["mergeTask"]>) => {
      const r = await mgr.mergeTask(...a); live--; return r;
    };
    return { mgr: wrapped, peak: () => peak };
  };

  it("merges two independent tasks", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a" });
      board.addCard({ id: "t2", title: "task-b" });
      const o = await runReady(edeps(mgr, fakeAdapter()), session, board);
      expect(o.merged.sort()).toEqual(["t1", "t2"]);
      expect(o.failed).toEqual([]);
      expect(o.skipped).toEqual([]);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  /**
   * The heart of it. Layered, the order is forced to A, C, B — C shares A's layer and B waits for the layer
   * to drain. Dependency-driven, B is runnable the moment A merges, so it goes before C.
   */
  it("starts a task as soon as its own dependency merges, not when its layer does", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const board = new Board();
      board.addCard({ id: "a", title: "task-a" });
      board.addCard({ id: "b", title: "task-b", deps: ["a"] });
      board.addCard({ id: "c", title: "task-c" }); // shares a's layer; nothing depends on it
      const o = await runReady({ ...edeps(mgr, fakeAdapter()), maxParallel: 1 }, session, board);
      expect(o.merged).toEqual(["a", "b", "c"]);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("never runs more than the cap at once", async () => {
    const repo = await initTmpRepo();
    try {
      const base = new WorktreeManager({ repoRoot: repo });
      const session = await base.openSession("main", "job");
      const { mgr, peak } = watched(base);
      const board = new Board();
      const ids = ["t1", "t2", "t3", "t4", "t5"];
      for (const id of ids) board.addCard({ id, title: `task-${id}` });
      const o = await runReady({ ...edeps(base, fakeAdapter()), manager: mgr, maxParallel: 2 }, session, board);
      expect(o.merged.sort()).toEqual(ids);
      expect(peak()).toBeLessThanOrEqual(2);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  /** The protection the layer split used to give, now applied against what is genuinely in flight. */
  it("does not run two tasks that write the same file at the same time", async () => {
    const repo = await initTmpRepo();
    try {
      const base = new WorktreeManager({ repoRoot: repo });
      const session = await base.openSession("main", "job");
      const { mgr, peak } = watched(base);
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a", files: ["src/store.ts"] });
      board.addCard({ id: "t2", title: "task-b", files: ["src/store.ts"] });
      const o = await runReady({ ...edeps(base, fakeAdapter()), manager: mgr, maxParallel: 4 }, session, board);
      expect(o.merged.sort()).toEqual(["t1", "t2"]);
      expect(peak()).toBe(1);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  /**
   * The number that is safe is a property of the user's subscriptions, and it is usually learned by watching
   * a job run — which is exactly when restarting to change it costs the most.
   */
  it("picks up a raised ceiling while the job is running", async () => {
    const repo = await initTmpRepo();
    try {
      const base = new WorktreeManager({ repoRoot: repo });
      const session = await base.openSession("main", "job");
      const { mgr, peak } = watched(base);
      const board = new Board();
      const ids = ["t1", "t2", "t3", "t4", "t5", "t6"];
      for (const id of ids) board.addCard({ id, title: `task-${id}` });
      let limit = 1;
      const deps = { ...edeps(base, fakeAdapter()), manager: mgr, get maxParallel() { return limit; } };
      const run = runReady(deps, session, board);
      limit = 3; // raised mid-flight
      const o = await run;
      expect(o.merged.sort()).toEqual(ids);
      expect(peak()).toBeGreaterThan(1); // the extra slots were actually used
      expect(peak()).toBeLessThanOrEqual(3);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("fails one task without touching its independent sibling", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a" });
      board.addCard({ id: "t2", title: "task-b" });
      const o = await runReady(edeps(mgr, fakeAdapter(), { failTasks: ["task-a"] }), session, board);
      expect(o.failed).toEqual(["t1"]);
      expect(o.merged).toEqual(["t2"]);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("skips everything downstream of a failure, however deep", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a" });
      board.addCard({ id: "t2", title: "task-b", deps: ["t1"] });
      board.addCard({ id: "t3", title: "task-c", deps: ["t2"] });
      const o = await runReady(edeps(mgr, fakeAdapter(), { failTasks: ["task-a"] }), session, board);
      expect(o.failed).toEqual(["t1"]);
      expect(o.skipped.sort()).toEqual(["t2", "t3"]);
      expect(board.get("t3")!.stageHistory.some((s) => s.action === "skipped")).toBe(true);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  /** Re-running a merged task would redo the whole implementation. */
  it("treats a task an earlier run finished as merged and does not run it again", async () => {
    const repo = await initTmpRepo();
    try {
      const base = new WorktreeManager({ repoRoot: repo });
      const session = await base.openSession("main", "job");
      const { mgr, peak } = watched(base);
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a" });
      board.move("t1", "MERGED", "coder");
      board.addCard({ id: "t2", title: "task-b", deps: ["t1"] });
      const o = await runReady({ ...edeps(base, fakeAdapter()), manager: mgr }, session, board);
      expect(o.merged.sort()).toEqual(["t1", "t2"]); // t1 counts as delivered…
      expect(peak()).toBe(1);                        // …but only t2 was ever derived
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
});

describe("runWaves", () => {
  it("runs with an injected session (doesn't call openSession), all-pass → completed + PR", async () => {
    const repo = await initTmpRepo();
    const bare = await mkdtemp(join(tmpdir(), "hc-bare-"));
    try {
      await defaultGitRunner(["init", "--bare", "-b", "main"], bare);
      await defaultGitRunner(["remote", "add", "origin", bare], repo);
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a" });
      const adapter = fakeAdapter();
      const res = await runWaves(edeps(mgr, adapter), session, board, { base: "main" });
      expect(res.status).toBe("completed");
      expect(adapter.calls).toBe(1);
      expect(res.session).toBe(session); // the same session was used
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });

  /**
   * `deps` said these two tasks were independent. Their file lists say otherwise, and the file lists are
   * evidence — a dependency the plan omits shows up as a merge conflict hours later, not as an error.
   */
  it("separates two tasks that would write the same file, and says why", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a", files: ["src/store.ts"] });
      board.addCard({ id: "t2", title: "task-b", files: ["src/store.ts"] });
      const notes: string[] = [];
      const deps = { ...edeps(mgr, fakeAdapter()), note: (t: string) => notes.push(t) };
      const res = await runWaves(deps, session, board, { base: "main" });
      expect(res.waves).toEqual([["t1"], ["t2"]]); // one wave each, not one wave racing
      expect(notes.join("\n")).toContain("same file");
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  /**
   * A resumed job sat at "Coding… 0 calls" with no agents for a minute: the first thing a wave run does is
   * read the plan and audit its dependencies, and nothing on screen said so.
   */
  it("says it is planning before the run goes quiet", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a" });
      const notes: string[] = [];
      await runWaves({ ...edeps(mgr, fakeAdapter()), note: (t: string) => notes.push(t) }, session, board, { base: "main" });
      expect(notes[0]).toMatch(/Planning the run/);
      expect(notes[0]).toContain("1 task(s) left");
      expect(notes[0]).toContain("at a time");
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  /**
   * A count says WHAT happened; a duration says what to fix. Without this the two candidates for "why is it
   * slow" — a stage that fails often and a stage that is simply slow — look identical on the board.
   */
  it("reports where the run's time went", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a" });
      const notes: string[] = [];
      const deps = { ...edeps(mgr, fakeAdapter()), timings: new Timings(), note: (t: string) => notes.push(t) };
      await runWaves(deps, session, board, { base: "main" });
      const said = notes.join("\n");
      expect(said).toMatch(/Slot time/);
      expect(said).toMatch(/implementation|code review|git/);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  /** The shape of the run is reported whether it went well or not — that is the point of measuring it. */
  it("reports the shape of the run", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a" });
      board.addCard({ id: "t2", title: "task-b" });
      const notes: string[] = [];
      await runWaves({ ...edeps(mgr, fakeAdapter()), note: (t: string) => notes.push(t) }, session, board, { base: "main" });
      expect(notes.join("\n")).toMatch(/2 task, 1 dependency layer/);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
});

describe("runWaveEngine", () => {
  it("completed: all pass → push + openPR", async () => {
    const repo = await initTmpRepo();
    const bare = await mkdtemp(join(tmpdir(), "hc-bare-"));
    try {
      await defaultGitRunner(["init", "--bare", "-b", "main"], bare);
      await defaultGitRunner(["remote", "add", "origin", bare], repo);
      const mgr = new WorktreeManager({ repoRoot: repo });
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a" });
      board.addCard({ id: "t2", title: "task-b", deps: ["t1"] });
      const adapter = fakeAdapter();
      const res = await runWaveEngine(edeps(mgr, adapter), board, { fromBranch: "main", jobName: "job" });
      expect(res.status).toBe("completed");
      expect(adapter.calls).toBe(1);
      if (res.status === "completed") expect(res.pr?.url).toBe("http://pr/1");
      expect(res.waves).toEqual([["t1"], ["t2"]]);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("partial: t1 fails → t2(dep t1) skipped → no PR opened", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a" });
      board.addCard({ id: "t2", title: "task-b", deps: ["t1"] });
      const adapter = fakeAdapter();
      const res = await runWaveEngine(edeps(mgr, adapter, { failTasks: ["task-a"] }), board, { fromBranch: "main", jobName: "job" });
      expect(res.status).toBe("partial");
      expect(adapter.calls).toBe(0);
      if (res.status === "partial") {
        expect(res.failed).toEqual(["t1"]);
        expect(res.skipped).toEqual(["t2"]);
      }
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("partial: transitive skip (t1 fail → t2 skip → t3 skip)", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a" });
      board.addCard({ id: "t2", title: "task-b", deps: ["t1"] });
      board.addCard({ id: "t3", title: "task-c", deps: ["t2"] });
      const adapter = fakeAdapter();
      const res = await runWaveEngine(edeps(mgr, adapter, { failTasks: ["task-a"] }), board, { fromBranch: "main", jobName: "job" });
      expect(res.status).toBe("partial");
      expect(adapter.calls).toBe(0);
      if (res.status === "partial") {
        expect(res.failed).toEqual(["t1"]);
        expect(res.skipped.sort()).toEqual(["t2", "t3"]);
      }
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("abort: pre-aborted signal → rethrows", async () => {
    const repo = await initTmpRepo();
    try {
      const ac = new AbortController();
      ac.abort();
      const mgr = new WorktreeManager({ repoRoot: repo });
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a" });
      await expect(
        runWaveEngine(edeps(mgr, fakeAdapter(), { signal: ac.signal }), board, { fromBranch: "main", jobName: "job" }),
      ).rejects.toThrow();
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
});

describe("resuming a partially finished board", () => {
  it("tasks already MERGED are not re-implemented — they are already in the base branch", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const session = await mgr.openSession("main", "job");
      const board = new Board();
      board.addCard({ id: "t1", title: "already finished" });
      board.addCard({ id: "t2", title: "still to do" });
      board.move("t1", "DONE", "code-reviewer"); // completed by an earlier, interrupted run
      const adapter = fakeAdapter();
      const d = edeps(mgr, adapter);
      const res = await runWaves(d, session, board, { base: "main" });
      expect(res.status).toBe("completed");
      expect(board.get("t1")!.column).toBe("MERGED"); // untouched
      // it was never re-routed/re-implemented: no request mentions its title
      const convo = (d.provider as { requests?: { messages: { content?: unknown }[] }[] }).requests ?? [];
      const text = convo.flatMap((r) => r.messages.map((m) => (typeof m.content === "string" ? m.content : ""))).join("\n");
      expect(text).not.toContain("already finished");
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
});

/**
 * The wave engine no longer merges.
 *
 * The review that runs after it commits to the same base branch, so merging here would deliver a snapshot
 * taken before the review's own fixes — the user's branch would be missing exactly the commits the review
 * was run to produce. Delivery moved to the end of the job, after the review.
 */
describe("delivery information", () => {
  it("always reports the branch the work is on, on a clean run", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a" });
      const res = await runWaveEngine(edeps(mgr, fakeAdapter()), board, { fromBranch: "main", jobName: "job" });
      expect(res.delivery.branch).toBe(res.session.baseBranch);
      expect(res.delivery.worktree).toBe(res.session.baseWorktree);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  it("reports it on a partial run too — the completed tasks are still real work", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a" });
      board.addCard({ id: "t2", title: "task-b", deps: ["t1"] });
      const res = await runWaveEngine(
        edeps(mgr, fakeAdapter(), { failTasks: ["task-a"] }), board, { fromBranch: "main", jobName: "job" });
      expect(res.status).toBe("partial");
      expect(res.delivery.branch).toBe(res.session.baseBranch);
    } finally { await rm(repo, { recursive: true, force: true }); }
  });

  /** Without a remote there is nowhere to open a pull request; the merge that replaces it happens later. */
  it("opens no pull request and merges nothing when there is no remote", async () => {
    const repo = await initTmpRepo();
    try {
      const mgr = new WorktreeManager({ repoRoot: repo });
      const board = new Board();
      board.addCard({ id: "t1", title: "task-a" });
      const adapter = fakeAdapter();
      const res = await runWaveEngine(edeps(mgr, adapter), board, { fromBranch: "main", jobName: "job" });
      expect(res.status).toBe("completed");
      expect(res.pr).toBeUndefined();
      expect(adapter.calls).toBe(0);
      expect(res.delivery.mergedInto).toBeUndefined();
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
});
