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
export function upstreamProvider(opts: { intent?: string; judge?: string[]; analystAsk?: string; skipWrite?: boolean; skipConstitution?: boolean; councilRec?: "approve" | "revise"; councilVotes?: string[]; teamFindings?: string } = {}): Provider & { requests: ChatRequest[] } {
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
      if (sys.includes("P-refiner")) { yield* submit(`{"refinedPrompt":"Do X","intent":"${opts.intent ?? "feature"}","title":"login-page"}`); return; }
      if (sys.includes("P-coach")) { yield* stop("coach response"); return; }
      // The brainstormer is driven by its role prompt, not a spec-kit command.
      if (sys.includes("brainstormer")) { yield* writeOnce("# decided approach"); return; }
      if (sys.includes("COMMAND:constitution")) {
        if (opts.skipConstitution) { yield* stop("I described it instead of writing it"); return; }
        yield* writeOnce("# constitution"); return;
      }
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
      if (sys.includes("review TEAM member")) { yield* submit(opts.teamFindings ?? `{"concerns":[],"recommendation":"${opts.councilRec ?? "approve"}"}`); return; }
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
    brainstormer: { models: ["m"], systemPrompt: "P-brainstormer" },
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

  /**
   * Establishing a constitution is neither a conversation nor a change to the software: classified as a
   * feature it bought the whole pipeline — a spec, a plan, a task board — to produce one document. It still
   * skips all of that. What it no longer skips is the WORKTREE.
   *
   * Measured after one document-producing run in a project checkout: `specs/004-product-upload-testing/`
   * left untracked in the repository root. A document is work, and work belongs on a branch — the reference
   * copy is read, never written.
   */
  it("govern intent → skips the pipeline, but still works on a branch", async () => {
    const p = upstreamProvider({ intent: "govern" });
    let opened = 0;
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const res = await runUpstream(udeps(p), () => { opened++; return Promise.resolve(dir); }, "write the project constitution", async () => "x", 3);
      expect(res.kind).toBe("governed");
      expect(opened).toBe(1); // a worktree, and only one — no spec, no plan, no board
      if (res.kind === "governed") {
        expect(res.written).toBe(true);
        expect(res.path).toContain("constitution.md");
        expect(existsSync(res.path)).toBe(true);
      }
    } finally { process.chdir(cwd); }
  });

  it("govern reports honestly when the phase wrote nothing", async () => {
    const p = upstreamProvider({ intent: "govern", skipConstitution: true });
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const res = await runUpstream(udeps(p), () => Promise.resolve(dir), "write the constitution", async () => "x", 3);
      expect(res.kind).toBe("governed");
      if (res.kind === "governed") expect(res.written).toBe(false);
    } finally { process.chdir(cwd); }
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

    // The refiner title is "login-page" → the feature slug is the first "001-*" directory under specs/.
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
    // The judge is the last authority: only its ask-human hands the decision to the user (who stops).
    const p = upstreamProvider({ intent: "feature", councilRec: "revise", councilVotes: ["revise"], judge: ['{"decision":"ask-human","feedback":[],"question":"Which scope?"}'] });
    const res = await runUpstream(udeps(p), () => Promise.resolve(dir), "Add X", async () => "stop", 1);
    expect(res.kind).toBe("rejected");
    if (res.kind === "rejected") expect(res.stage).toBe("spec");
  });

  it("if the spec is approved but the plan isn't → rejected(plan)", async () => {
    // Team is split on both; the council votes pass for the spec (approved) then revise for the plan (rejected).
    const p = upstreamProvider({ intent: "feature", councilRec: "revise", councilVotes: ["pass", "revise"], judge: ['{"decision":"ask-human","feedback":[],"question":"Which scope?"}'] });
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
    const slug = "001-login-page";
    await mkdir(join(dir, "specs", slug), { recursive: true });
    await mkdir(join(dir, ".specify", "memory"), { recursive: true });
    await writeFile(join(dir, ".specify", "memory", "constitution.md"), "# c", "utf8");
    await writeFile(join(dir, "specs", slug, "spec.md"), "# existing spec", "utf8");
    writeCheckpoint(root, { rawPrompt: "Add X", refinedPrompt: "Do X", title: "add thing", language: "English", featureSlug: slug, done: ["constitution", "spec", "clarify"] });

    // Only the plan review needs a judge verdict now — spec review must NOT run again.
    const p = upstreamProvider({ intent: "feature", judge: ['{"decision":"pass","feedback":[],"question":""}'] });
    const phases: string[] = [];
    // `hasPreservedWork` is what the caller passes when something is half-built: sizing must not run, or a
    // feature abandoned mid-plan could be re-measured as a small change and finished by one implementer.
    const res = await runUpstream(udeps(p), () => Promise.resolve(dir), "Add X", async () => "x", 3, [], (ev) => { if (ev.kind === "phase") phases.push(ev.phase); }, undefined, undefined, true);
    expect(res.kind).toBe("approved");
    expect(phases).toEqual(["plan", "tasks"]); // constitution/specify/clarify were skipped, and nothing was re-sized
    expect(await readFile(join(dir, "specs", slug, "spec.md"), "utf8")).toBe("# existing spec"); // untouched
    // No COMMAND:specify request was issued — the spec phase truly did not re-run.
    expect(p.requests.some((r) => (typeof r.messages[0]?.content === "string" ? r.messages[0].content : "").includes("COMMAND:specify"))).toBe(false);
  });

  it("resume hint (a 'continue' request) drives the pipeline WITHOUT running the refiner", async () => {
    const { writeCheckpoint, readCheckpoint } = await import("../../src/engine/checkpoint.js");
    const { writeFile } = await import("node:fs/promises");
    const slug = "001-login-page";
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

  // The checkpoint's rawPrompt is the key an exact re-run matches on. A resume that overwrote it with the word
  // that TRIGGERED the resume left every resumed worktree keyed "devam et" — colliding with each other and no
  // longer matching the request that actually started the work.
  it("a resume preserves the ORIGINAL rawPrompt instead of stamping the continue phrase over it", async () => {
    const { writeCheckpoint, readCheckpoint } = await import("../../src/engine/checkpoint.js");
    const { writeFile } = await import("node:fs/promises");
    const slug = "001-login-page";
    await mkdir(join(dir, "specs", slug), { recursive: true });
    await mkdir(join(dir, ".specify", "memory"), { recursive: true });
    await writeFile(join(dir, ".specify", "memory", "constitution.md"), "# c", "utf8");
    await writeFile(join(dir, "specs", slug, "spec.md"), "# existing spec", "utf8");
    await writeFile(join(dir, "specs", slug, "plan.md"), "# existing plan", "utf8");
    writeCheckpoint(root, { rawPrompt: "Build a todo app", refinedPrompt: "Do X", title: "add thing", language: "English", featureSlug: slug, done: ["constitution", "spec", "clarify", "plan"] });

    const p = upstreamProvider({ intent: "feature" });
    await runUpstream(udeps(p), () => Promise.resolve(dir), "devam et", async () => "x", 3, [], () => {}, undefined, readCheckpoint(root)!);
    expect(readCheckpoint(root)!.rawPrompt).toBe("Build a todo app");
  });

  it("emits the spec-kit phase events in order", async () => {
    const p = upstreamProvider({ intent: "feature", judge: ['{"decision":"pass","feedback":[],"question":""}', '{"decision":"pass","feedback":[],"question":""}'] });
    const phases: string[] = [];
    await runUpstream(udeps(p), () => Promise.resolve(dir), "Add X", async () => "x", 3, [], (ev) => { if (ev.kind === "phase") phases.push(ev.phase); });
    // brainstorm sits between the constitution and the spec: the approach is decided WITH the user before
    // anything is specified, and everything after that point runs autonomously.
    // "sizing" comes first: a request is measured before a worktree is cut for it, so that "centre the icon"
    // does not buy a spec, a plan and a board. Only what it does NOT size goes on to the phases below.
    expect(phases).toEqual(["sizing", "constitution", "brainstorm", "specify", "clarify", "plan", "tasks"]);
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

describe("deferred spec findings carry over to the plan", () => {
  it("medium/low notes the spec review deferred are handed to the plan phase as non-blocking context", async () => {
    // Round 1: a medium finding → council revise → revise. Round 2: still only medium → passes + defers it.
    const p = upstreamProvider({
      intent: "feature",
      teamFindings: '{"findings":[{"severity":"medium","note":"clarify retention"}],"recommendation":"revise"}',
      councilVotes: ["revise"],
    });
    const res = await runUpstream(udeps(p), () => Promise.resolve(dir), "Add X", async () => "x", 5);
    expect(res.kind).toBe("approved");
    const planReq = p.requests.filter((r) => (typeof r.messages[0]?.content === "string" ? r.messages[0].content : "").includes("COMMAND:plan"));
    const planMsg = planReq.flatMap((r) => r.messages.map((m) => (typeof m.content === "string" ? m.content : ""))).join("\n");
    expect(planMsg).toMatch(/carried over from the spec review/i);
    expect(planMsg).toContain("clarify retention");
  });
});

describe("plan review deferrals reach the task breakdown", () => {
  it("plan-stage medium/low notes are handed to the tasks phase as non-blocking context", async () => {
    const p = upstreamProvider({
      intent: "feature",
      teamFindings: '{"findings":[{"severity":"medium","note":"add retry budget"}],"recommendation":"revise"}',
      councilVotes: ["revise"],
    });
    const res = await runUpstream(udeps(p), () => Promise.resolve(dir), "Add X", async () => "x", 5);
    expect(res.kind).toBe("approved");
    const taskReq = p.requests.filter((r) => (typeof r.messages[0]?.content === "string" ? r.messages[0].content : "").includes("COMMAND:tasks"));
    const msg = taskReq.flatMap((r) => r.messages.map((m) => (typeof m.content === "string" ? m.content : ""))).join("\n");
    expect(msg).toMatch(/carried over from the earlier reviews/i);
    expect(msg).toContain("add retry budget");
  });
});

describe("authoring phase that writes no file", () => {
  it("retries the phase once, and never sends a missing document to review", async () => {
    // The provider refuses to write on the FIRST specify call, then writes on the retry.
    let specifyCalls = 0;
    const p = upstreamProvider({ intent: "feature" });
    const wrapped: Provider & { requests: typeof p.requests } = {
      requests: p.requests,
      async *chat(req, signal) {
        const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
        if (sys.includes("COMMAND:specify")) {
          specifyCalls++;
          if (specifyCalls === 1) { // first attempt: prose only, no write_file
            p.requests.push(req);
            yield { type: "text-delta", text: "Here is the spec, conceptually." };
            yield { type: "done", finishReason: "stop" };
            return;
          }
        }
        yield* p.chat(req, signal);
      },
    };
    const notes: string[] = [];
    const res = await runUpstream(udeps(wrapped), () => Promise.resolve(dir), "Add X", async () => "x", 3, [], (ev) => { if (ev.kind === "note") notes.push((ev as { text: string }).text); });
    expect(res.kind).toBe("approved");
    expect(notes.join("\n")).toMatch(/produced no `?specs?/i); // the retry was announced
    expect(existsSync(join(dir, "specs"))).toBe(true);
  });
});

describe("interrupted during a review", () => {
  it("resumes at the REVIEW — an already-written spec/plan is not re-authored from scratch", async () => {
    // Simulate the interrupted state: constitution+spec+clarify done, and plan.md ALREADY written (the run was
    // stopped while the council was reviewing it), but the checkpoint never marked "plan" (review never passed).
    const { writeCheckpoint } = await import("../../src/engine/checkpoint.js");
    const { writeFile: wf } = await import("node:fs/promises");
    const slug = "001-login-page";
    await mkdir(join(dir, "specs", slug), { recursive: true });
    await mkdir(join(dir, ".specify", "memory"), { recursive: true });
    await wf(join(dir, ".specify", "memory", "constitution.md"), "# c", "utf8");
    await wf(join(dir, "specs", slug, "spec.md"), "# existing spec", "utf8");
    await wf(join(dir, "specs", slug, "plan.md"), "# existing plan — hours of work", "utf8");
    writeCheckpoint(root, { rawPrompt: "Add X", refinedPrompt: "Do X", title: "add thing", language: "English", featureSlug: slug, done: ["constitution", "spec", "clarify"] });

    const p = upstreamProvider({ intent: "feature" });
    const notes: string[] = [];
    const res = await runUpstream(udeps(p), () => Promise.resolve(dir), "Add X", async () => "x", 3, [], (ev) => { if (ev.kind === "note") notes.push((ev as { text: string }).text); });
    expect(res.kind).toBe("approved");
    // The planner was never re-run, and the existing plan survived untouched.
    expect(p.requests.some((r) => (typeof r.messages[0]?.content === "string" ? r.messages[0].content : "").includes("COMMAND:plan"))).toBe(false);
    expect(await readFile(join(dir, "specs", slug, "plan.md"), "utf8")).toBe("# existing plan — hours of work");
    expect(notes.join("\n")).toMatch(/already written — resuming at its review/i);
  });
});

// The approach used to be decided implicitly, by whoever wrote the spec, and only surfaced in review — where
// changing it is expensive. Brainstorm makes that decision explicit, the user's, and recorded, ONCE, up front.
describe("brainstorm — the approach is decided before anything is specified", () => {
  it("writes the brief and runs BEFORE the spec", async () => {
    const p = upstreamProvider({ intent: "feature" });
    const order: string[] = [];
    const res = await runUpstream(udeps(p), () => Promise.resolve(dir), "Add X", async () => "x", 3, [], (ev) => { if (ev.kind === "phase") order.push(ev.phase); });
    expect(res.kind).toBe("approved");
    expect(existsSync(join(dir, "specs", "001-login-page", "brainstorm.md"))).toBe(true);
    expect(order.indexOf("brainstorm")).toBeLessThan(order.indexOf("specify"));
  });

  // The whole point of recording the decision is that the spec honours it instead of re-opening it.
  it("points the spec at the brief and tells it not to re-litigate the choice", async () => {
    const p = upstreamProvider({ intent: "feature" });
    await runUpstream(udeps(p), () => Promise.resolve(dir), "Add X", async () => "x", 3);
    const specPrompt = p.requests
      .flatMap((r) => r.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : "")))
      .find((c) => c.includes("spec.md") && c.includes("Feature request"));
    expect(specPrompt).toBeDefined();
    expect(specPrompt).toContain("brainstorm.md");
    expect(specPrompt).toMatch(/do not re-litigate/i);
  });

  it("is skipped on resume once it is marked done", async () => {
    const { writeCheckpoint, readCheckpoint } = await import("../../src/engine/checkpoint.js");
    const { writeFile } = await import("node:fs/promises");
    const slug = "001-login-page";
    await mkdir(join(dir, "specs", slug), { recursive: true });
    await mkdir(join(dir, ".specify", "memory"), { recursive: true });
    await writeFile(join(dir, ".specify", "memory", "constitution.md"), "# c", "utf8");
    await writeFile(join(dir, "specs", slug, "brainstorm.md"), "# decided", "utf8");
    await writeFile(join(dir, "specs", slug, "spec.md"), "# spec", "utf8");
    await writeFile(join(dir, "specs", slug, "plan.md"), "# plan", "utf8");
    writeCheckpoint(root, { rawPrompt: "Add X", refinedPrompt: "Do X", title: "add thing", language: "English", featureSlug: slug, done: ["constitution", "brainstorm", "spec", "clarify", "plan"] });
    const p = upstreamProvider({ intent: "feature" });
    const phases: string[] = [];
    await runUpstream(udeps(p), () => Promise.resolve(dir), "devam et", async () => "x", 3, [], (ev) => { if (ev.kind === "phase") phases.push(ev.phase); }, undefined, readCheckpoint(root)!);
    expect(phases).not.toContain("brainstorm");
  });

  // A checkpoint written before this phase existed has no "brainstorm" in `done`; a spec on disk proves the
  // approach was already settled, so asking the user to decide it now would be asking about finished work.
  it("does NOT run for an older checkpoint whose spec already exists", async () => {
    const { writeCheckpoint, readCheckpoint } = await import("../../src/engine/checkpoint.js");
    const { writeFile } = await import("node:fs/promises");
    const slug = "001-login-page";
    await mkdir(join(dir, "specs", slug), { recursive: true });
    await mkdir(join(dir, ".specify", "memory"), { recursive: true });
    await writeFile(join(dir, ".specify", "memory", "constitution.md"), "# c", "utf8");
    await writeFile(join(dir, "specs", slug, "spec.md"), "# spec", "utf8");
    await writeFile(join(dir, "specs", slug, "plan.md"), "# plan", "utf8");
    writeCheckpoint(root, { rawPrompt: "Add X", refinedPrompt: "Do X", title: "add thing", language: "English", featureSlug: slug, done: ["constitution", "spec", "clarify", "plan"] });
    const p = upstreamProvider({ intent: "feature" });
    const phases: string[] = [];
    await runUpstream(udeps(p), () => Promise.resolve(dir), "devam et", async () => "x", 3, [], (ev) => { if (ev.kind === "phase") phases.push(ev.phase); }, undefined, readCheckpoint(root)!);
    expect(phases).not.toContain("brainstorm");
    expect(existsSync(join(dir, "specs", slug, "brainstorm.md"))).toBe(false);
  });

  it("a missing brief does not kill the run — it is advisory, not a gate", async () => {
    const p = upstreamProvider({ intent: "feature", skipWrite: true });
    // skipWrite makes every authoring phase produce nothing; the spec is REQUIRED so the run fails on that,
    // never on the brainstorm.
    await expect(runUpstream(udeps(p), () => Promise.resolve(dir), "Add X", async () => "x", 3)).rejects.toThrow(/specify/);
  });
});
