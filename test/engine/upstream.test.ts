import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAskUserTool, runUpstream } from "../../src/engine/upstream.js";
import type { ReviewDeps } from "../../src/engine/review.js";
import { reviewBodies } from "../support/review-bodies.js";
import type { ReviewerConfig, RoleConfig } from "../../src/config/config.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { Provider, ChatRequest, ToolContext } from "../../src/core/types.js";
import { fakeSpecKit } from "../support/fake-speckit.js";

// `root` is the per-job worktree root; the pipeline writes into `root/base` (workdir) and drops the resume
// checkpoint at `root/checkpoint.json` (a sibling of base, never committed). `dir` mirrors that contract so
// each test's checkpoint is isolated under its own root (and cleaned by afterEach).
let root: string;
let dir: string; // = root/base, the worktree the pipeline writes into
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "hc-upstream-")); dir = join(root, "base"); await mkdir(dir, { recursive: true }); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const ctx = (): ToolContext => ({ cwd: ".", signal: new AbortController().signal });

// Content-based provider scripting the spec-kit pipeline: it keys off the systemPrompt (refiner / coach /
// council perspective / judge) and, for the spec-kit phases, off the spec-kit command text ("COMMAND:<phase>"
// injected by fakeSpecKit). Captures every request for assertions.
export function upstreamProvider(opts: { intent?: string; judge?: string[]; analystAsk?: string; skipWrite?: boolean; councilRec?: "approve" | "revise"; councilVotes?: string[] } = {}): Provider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let judgeCall = 0;
  let councilCall = 0;
  return {
    requests,
    async *chat(req) {
      requests.push(req);
      const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      const toolMsgs = req.messages.filter((m) => m.role === "tool");
      const userContent = req.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      // The phase prompts always name the write target LAST (spec/plan/tasks messages also mention upstream
      // files), so take the last quoted *.md path.
      const mds = [...userContent.matchAll(/"([^"]+\.md)"/g)].map((m) => m[1]);
      const writeTarget = mds.length ? mds[mds.length - 1] : "spec.md";
      const submit = function* (a: string) {
        yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: a } } as const;
        yield { type: "done", finishReason: "tool_calls" } as const;
      };
      const call = function* (name: string, a: string) {
        yield { type: "tool-call", toolCall: { id: "t", name, arguments: a } } as const;
        yield { type: "done", finishReason: "tool_calls" } as const;
      };
      const stop = function* (t: string) {
        yield { type: "text-delta", text: t } as const;
        yield { type: "done", finishReason: "stop" } as const;
      };
      const writeOnce = function* (content: string) {
        if (!toolMsgs.some((m) => m.name === "write_file")) { yield* call("write_file", JSON.stringify({ path: writeTarget, content })); return; }
        yield* stop("done");
      };
      if (sys.includes("P-refiner")) { yield* submit(`{"refinedPrompt":"Do X","intent":"${opts.intent ?? "feature"}","title":"add-thing"}`); return; }
      if (sys.includes("P-coach")) { yield* stop("coach response"); return; }
      if (sys.includes("COMMAND:constitution")) { yield* writeOnce("# constitution"); return; }
      if (sys.includes("COMMAND:specify")) {
        if (opts.skipWrite) { yield* stop("I didn't write it"); return; } // specify that doesn't produce a file (guard test)
        if (opts.analystAsk && toolMsgs.length === 0) { yield* call("ask_user", JSON.stringify({ question: opts.analystAsk })); return; }
        yield* writeOnce("# spec"); return;
      }
      if (sys.includes("COMMAND:clarify")) { yield* submit('{"nextQuestion":null}'); return; }
      if (sys.includes("COMMAND:plan")) { yield* writeOnce("# plan"); return; }
      if (sys.includes("COMMAND:tasks")) { yield* writeOnce("# tasks"); return; }
      if (sys.includes("Conventional Commits")) { yield* submit('{"message":"chore: test step"}'); return; }
      if (sys.includes("review COUNCIL")) { // council decider → cast a pass/revise vote
        const arr = opts.councilVotes ?? ["pass"];
        yield* submit(`{"vote":"${arr[councilCall] ?? arr[arr.length - 1]}","rationale":"r"}`); councilCall++; return;
      }
      if (sys.includes("review TEAM member")) { yield* submit(`{"concerns":[],"recommendation":"${opts.councilRec ?? "approve"}"}`); return; }
      if (sys.includes("P-judge")) {
        const arr = opts.judge ?? ['{"decision":"pass","feedback":[],"question":""}'];
        yield* submit(arr[judgeCall] ?? arr[arr.length - 1]);
        judgeCall++;
        return;
      }
      yield* stop("ok");
    },
  };
}

export function udeps(provider: Provider, signal?: AbortSignal): ReviewDeps {
  const roles: Record<string, RoleConfig> = {
    refiner: { models: ["m"], systemPrompt: "P-refiner" },
    coach: { models: ["m"], systemPrompt: "P-coach" },
    analyst: { models: ["m"], systemPrompt: "P-analyst" },
    planner: { models: ["m"], systemPrompt: "P-planner" },
    "project-manager": { models: ["m"], systemPrompt: "P-pm" },
    judge: { models: ["m"], systemPrompt: "P-judge" },
    operational: { models: ["m"], systemPrompt: "Write Conventional Commits messages." },
  };
  const team: ReviewerConfig[] = [{ name: "sec", perspective: "security", models: ["m"] }];
  const council: ReviewerConfig[] = [{ name: "risk-judge", perspective: "risk", models: ["m"] }];
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: signal ?? new AbortController().signal,
    specKit: fakeSpecKit,
    ...reviewBodies({ spec: team, plan: team, code: team, council }),
  };
}

describe("buildAskUserTool", () => {
  it("calls askUser, returns the answer in content", async () => {
    let asked = "";
    const t = buildAskUserTool(async (q) => { asked = q; return "my answer"; });
    const res = await t.run({ question: "X or?" }, ctx());
    expect(asked).toBe("X or?");
    expect(res.content).toBe("my answer");
    expect(res.isError).toBe(false);
  });

  it("invalid args → isError", async () => {
    const t = buildAskUserTool(async () => "x");
    const res = await t.run({}, ctx());
    expect(res.isError).toBe(true);
  });

  it("passes options + multiSelect through to askUser (multiple-choice question)", async () => {
    let gotOpts: unknown;
    const t = buildAskUserTool(async (_q, opts) => { gotOpts = opts; return "A; B"; });
    const res = await t.run({ question: "pick", options: ["A", "B", "C"], multiSelect: true }, ctx());
    expect(gotOpts).toEqual({ options: ["A", "B", "C"], multiSelect: true });
    expect(res.content).toBe("A; B");
  });
});

describe("runUpstream", () => {
  it("chat intent → coach response, without opening a worktree", async () => {
    const p = upstreamProvider({ intent: "chat" });
    let opened = 0;
    const res = await runUpstream(udeps(p), () => { opened++; return Promise.resolve(dir); }, "hello", async () => "x", 3);
    expect(res.kind).toBe("chat");
    if (res.kind === "chat") expect(res.response).toBe("coach response");
    expect(res.intent).toBe("chat");
    expect(opened).toBe(0); // a chat turn must never open the worktree
  });

  it("chat intent never invokes the spec-kit loader (regression guard: a fetch failure must not brick chat)", async () => {
    const p = upstreamProvider({ intent: "chat" });
    let loaded = 0;
    const d = { ...udeps(p), specKit: () => { loaded++; return Promise.reject(new Error("spec-kit must not load on a chat turn")); } };
    const res = await runUpstream(d, () => Promise.resolve(dir), "hello", async () => "x", 3);
    expect(res.kind).toBe("chat");
    expect(loaded).toBe(0); // the loader was never called → no fetch happened
  });

  it("feature intent runs the spec-kit pipeline: constitution + specify + clarify + plan + tasks → approved", async () => {
    const p = upstreamProvider({ intent: "feature", judge: ['{"decision":"pass","feedback":[],"question":""}', '{"decision":"pass","feedback":[],"question":""}'] });
    let opened = 0;
    const res = await runUpstream(udeps(p), () => { opened++; return Promise.resolve(dir); }, "Add X", async () => "x", 3);
    expect(res.kind).toBe("approved");
    expect(opened).toBe(1); // the feature pipeline opens the worktree exactly once

    // The refiner title is "add-thing" → the feature slug is the first "001-*" directory under specs/.
    const featureDirs = await readdir(join(dir, "specs"));
    expect(featureDirs).toHaveLength(1);
    const slug = featureDirs[0];
    expect(slug).toMatch(/^001-/);

    // Constitution + all three feature artifacts exist with the phase content.
    expect(await readFile(join(dir, ".specify/memory/constitution.md"), "utf8")).toBe("# constitution");
    expect(await readFile(join(dir, "specs", slug, "spec.md"), "utf8")).toBe("# spec");
    expect(await readFile(join(dir, "specs", slug, "plan.md"), "utf8")).toBe("# plan");
    expect(await readFile(join(dir, "specs", slug, "tasks.md"), "utf8")).toBe("# tasks");

    if (res.kind === "approved") {
      expect(res.specPath).toBe(join("specs", slug, "spec.md"));
      expect(res.planPath).toBe(join("specs", slug, "plan.md"));
      expect(res.tasksPath).toBe(join("specs", slug, "tasks.md"));
    }
  });

  it("skips the constitution phase when one already exists", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dir, ".specify", "memory"), { recursive: true });
    await writeFile(join(dir, ".specify", "memory", "constitution.md"), "# existing", "utf8");
    const p = upstreamProvider({ intent: "feature", judge: ['{"decision":"pass","feedback":[],"question":""}', '{"decision":"pass","feedback":[],"question":""}'] });
    const res = await runUpstream(udeps(p), () => Promise.resolve(dir), "Add X", async () => "x", 3);
    expect(res.kind).toBe("approved");
    // Untouched: no constitution phase ran, so the pre-existing content stays.
    expect(await readFile(join(dir, ".specify/memory/constitution.md"), "utf8")).toBe("# existing");
    expect(p.requests.some((r) => (typeof r.messages[0]?.content === "string" ? r.messages[0].content : "").includes("COMMAND:constitution"))).toBe(false);
  });

  it("if the spec isn't approved → rejected(spec)", async () => {
    // Team is split (revise) → council convenes; a revise vote → revise; the single round then escalates → stop.
    const p = upstreamProvider({ intent: "feature", councilRec: "revise", councilVotes: ["revise"] });
    const res = await runUpstream(udeps(p), () => Promise.resolve(dir), "Add X", async () => "stop", 1);
    expect(res.kind).toBe("rejected");
    if (res.kind === "rejected") expect(res.stage).toBe("spec");
  });

  it("if the spec is approved but the plan isn't → rejected(plan)", async () => {
    // Team is split on both; the council votes pass for the spec (approved) then revise for the plan (rejected).
    const p = upstreamProvider({ intent: "feature", councilRec: "revise", councilVotes: ["pass", "revise"] });
    const res = await runUpstream(udeps(p), () => Promise.resolve(dir), "Add X", async () => "stop", 1);
    expect(res.kind).toBe("rejected");
    if (res.kind === "rejected") expect(res.stage).toBe("plan");
  });

  it("emits a refined event with the refined prompt before running downstream", async () => {
    const p = upstreamProvider({ intent: "chat" });
    const events: { kind: string; refinedPrompt?: string }[] = [];
    await runUpstream(udeps(p), () => Promise.resolve(dir), "hello", async () => "x", 3, [], (ev) => events.push(ev));
    expect(events).toContainEqual({ kind: "refined", refinedPrompt: "Do X" });
  });

  it("resumes from a checkpoint: skips already-done phases (spec review only re-runs for the unfinished plan)", async () => {
    const { writeCheckpoint } = await import("../../src/engine/checkpoint.js");
    const { writeFile } = await import("node:fs/promises");
    // Simulate an interrupted run: constitution + spec + clarify are done; plan/tasks remain. Pre-place the
    // artifacts the completed phases already produced so the reused paths line up.
    const slug = "001-add-thing";
    await mkdir(join(dir, "specs", slug), { recursive: true });
    await mkdir(join(dir, ".specify", "memory"), { recursive: true });
    await writeFile(join(dir, ".specify", "memory", "constitution.md"), "# c", "utf8");
    await writeFile(join(dir, "specs", slug, "spec.md"), "# existing spec", "utf8");
    writeCheckpoint(root, { rawPrompt: "Add X", refinedPrompt: "Do X", title: "add thing", language: "English", featureSlug: slug, done: ["constitution", "spec", "clarify"] });

    // Only the plan review needs a judge verdict now — spec review must NOT run again.
    const p = upstreamProvider({ intent: "feature", judge: ['{"decision":"pass","feedback":[],"question":""}'] });
    const phases: string[] = [];
    const res = await runUpstream(udeps(p), () => Promise.resolve(dir), "Add X", async () => "x", 3, [], (ev) => { if (ev.kind === "phase") phases.push(ev.phase); });
    expect(res.kind).toBe("approved");
    expect(phases).toEqual(["plan", "tasks"]); // constitution/specify/clarify were skipped
    expect(await readFile(join(dir, "specs", slug, "spec.md"), "utf8")).toBe("# existing spec"); // untouched
    // No COMMAND:specify request was issued — the spec phase truly did not re-run.
    expect(p.requests.some((r) => (typeof r.messages[0]?.content === "string" ? r.messages[0].content : "").includes("COMMAND:specify"))).toBe(false);
  });

  it("resume hint (a 'continue' request) drives the pipeline WITHOUT running the refiner", async () => {
    const { writeCheckpoint, readCheckpoint } = await import("../../src/engine/checkpoint.js");
    const { writeFile } = await import("node:fs/promises");
    const slug = "001-add-thing";
    await mkdir(join(dir, "specs", slug), { recursive: true });
    await mkdir(join(dir, ".specify", "memory"), { recursive: true });
    await writeFile(join(dir, ".specify", "memory", "constitution.md"), "# c", "utf8");
    await writeFile(join(dir, "specs", slug, "spec.md"), "# existing spec", "utf8");
    await writeFile(join(dir, "specs", slug, "plan.md"), "# existing plan", "utf8");
    writeCheckpoint(root, { rawPrompt: "Build a todo app", refinedPrompt: "Do X", title: "add thing", language: "English", featureSlug: slug, done: ["constitution", "spec", "clarify", "plan"] });

    const p = upstreamProvider({ intent: "feature" });
    // The user typed a bare "continue" (matches no rawPrompt), and job.ts passes the checkpoint as the resume hint.
    const res = await runUpstream(udeps(p), () => Promise.resolve(dir), "kaldığımız yerden devam edelim", async () => "x", 3, [], () => {}, undefined, readCheckpoint(root)!);
    expect(res.kind).toBe("approved");
    if (res.kind === "approved") expect(res.refinedPrompt).toBe("Do X"); // came from the checkpoint, not the refiner
    // The refiner was never invoked — no P-refiner request was made.
    expect(p.requests.some((r) => (typeof r.messages[0]?.content === "string" ? r.messages[0].content : "").includes("P-refiner"))).toBe(false);
  });

  it("emits the spec-kit phase events in order", async () => {
    const p = upstreamProvider({ intent: "feature", judge: ['{"decision":"pass","feedback":[],"question":""}', '{"decision":"pass","feedback":[],"question":""}'] });
    const phases: string[] = [];
    await runUpstream(udeps(p), () => Promise.resolve(dir), "Add X", async () => "x", 3, [], (ev) => { if (ev.kind === "phase") phases.push(ev.phase); });
    expect(phases).toEqual(["constitution", "specify", "clarify", "plan", "tasks"]);
  });

  it("throws if cancelled", async () => {
    const ac = new AbortController(); ac.abort();
    const p = upstreamProvider({ intent: "feature" });
    await expect(runUpstream(udeps(p, ac.signal), () => Promise.resolve(dir), "X", async () => "x", 2)).rejects.toThrow();
  });

  it("throws if specify doesn't produce a spec file (even if the judge still passes it)", async () => {
    const p = upstreamProvider({ intent: "feature", skipWrite: true, judge: ['{"decision":"pass","feedback":[],"question":""}'] });
    await expect(runUpstream(udeps(p), () => Promise.resolve(dir), "X", async () => "x", 1)).rejects.toThrow(/spec/);
    expect(existsSync(join(dir, ".specify/memory/constitution.md"))).toBe(true); // constitution still ran
  });
});
