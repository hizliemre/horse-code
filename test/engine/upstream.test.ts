import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAskUserTool, runAnalyst, runPlanner, runUpstream } from "../../src/engine/upstream.js";
import type { ReviewDeps } from "../../src/engine/review.js";
import { buildCouncilRegistry } from "../../src/engine/review.js";
import type { CouncilorConfig, RoleConfig } from "../../src/config/config.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { Provider, ChatRequest, ToolContext } from "../../src/core/types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-upstream-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const ctx = (): ToolContext => ({ cwd: ".", signal: new AbortController().signal });

// Content-based provider: responds based on systemPrompt (role) + tool messages; captures requests.
export function upstreamProvider(opts: { intent?: string; judge?: string[]; analystAsk?: string; skipWrite?: boolean } = {}): Provider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let judgeCall = 0;
  return {
    requests,
    async *chat(req) {
      requests.push(req);
      const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      const toolMsgs = req.messages.filter((m) => m.role === "tool");
      const userContent = req.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      const writeTarget = (userContent.match(/"([^"]+\.md)" with write_file/) ?? userContent.match(/"([^"]+\.md)"/))?.[1] ?? "spec.md";
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
      if (sys.includes("P-refiner")) { yield* submit(`{"refinedPrompt":"Do X","intent":"${opts.intent ?? "feature"}"}`); return; }
      if (sys.includes("P-coach")) { yield* stop("coach response"); return; }
      if (sys.includes("P-analyst")) {
        if (opts.skipWrite) { yield* stop("I didn't write it"); return; } // analyst that doesn't produce a file (guard test)
        if (opts.analystAsk && toolMsgs.length === 0) { yield* call("ask_user", JSON.stringify({ question: opts.analystAsk })); return; }
        if (!toolMsgs.some((m) => m.name === "write_file")) { yield* call("write_file", JSON.stringify({ path: writeTarget, content: "# spec" })); return; }
        yield* stop("done"); return;
      }
      if (sys.includes("P-planner")) {
        if (!toolMsgs.some((m) => m.name === "write_file")) { yield* call("write_file", JSON.stringify({ path: writeTarget, content: "# plan" })); return; }
        yield* stop("done"); return;
      }
      if (sys.includes("perspective")) { yield* submit('{"concerns":[],"recommendation":"approve"}'); return; }
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
    judge: { models: ["m"], systemPrompt: "P-judge" },
  };
  const councilors: CouncilorConfig[] = [{ name: "sec", perspective: "security", models: ["m"] }];
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: signal ?? new AbortController().signal,
    councilRegistry: buildCouncilRegistry(councilors),
    councilors,
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
});

describe("runAnalyst", () => {
  it("writes the spec file; toolset contains ask_user+write, no shell", async () => {
    const p = upstreamProvider({});
    await runAnalyst(udeps(p), dir, "spec.md", "Do X", undefined, async () => "x");
    expect(await readFile(join(dir, "spec.md"), "utf8")).toBe("# spec");
    const names = p.requests[0].tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["ask_user", "write_file", "read_file", "grep", "glob", "skill"]));
    expect(names).not.toContain("shell");
    expect(names).not.toContain("web_fetch");
  });

  it("if feedback is non-empty, the notes appear in the request (revision)", async () => {
    const p = upstreamProvider({});
    await runAnalyst(udeps(p), dir, "spec.md", "Do X", ["was left untested"], async () => "x");
    const userMsg = p.requests[0].messages.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).toContain("was left untested");
  });

  it("if the analyst calls ask_user, askUser is triggered", async () => {
    const p = upstreamProvider({ analystAsk: "X or Y?" });
    let asked = "";
    await runAnalyst(udeps(p), dir, "spec.md", "Do X", undefined, async (q) => { asked = q; return "X"; });
    expect(asked).toBe("X or Y?");
    expect(await readFile(join(dir, "spec.md"), "utf8")).toBe("# spec");
  });
});

describe("runPlanner", () => {
  it("writes the plan file; toolset has write, no ask_user", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = upstreamProvider({});
    await runPlanner(udeps(p), dir, "plan.md", "spec.md", undefined);
    expect(await readFile(join(dir, "plan.md"), "utf8")).toBe("# plan");
    const names = p.requests[0].tools.map((t) => t.name);
    expect(names).toContain("write_file");
    expect(names).not.toContain("ask_user");
  });

  it("if feedback is non-empty, the notes appear in the request", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = upstreamProvider({});
    await runPlanner(udeps(p), dir, "plan.md", "spec.md", ["missing the rollout wave"]);
    const userMsg = p.requests[0].messages.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).toContain("missing the rollout wave");
  });
});

describe("runUpstream", () => {
  it("chat intent → coach response", async () => {
    const p = upstreamProvider({ intent: "chat" });
    const res = await runUpstream(udeps(p), dir, "hello", async () => "x", 3);
    expect(res.kind).toBe("chat");
    if (res.kind === "chat") expect(res.response).toBe("coach response");
    expect(res.intent).toBe("chat");
  });

  it("feature → spec+plan approved → approved, both files written", async () => {
    const p = upstreamProvider({ intent: "feature", judge: ['{"decision":"pass","feedback":[],"question":""}', '{"decision":"pass","feedback":[],"question":""}'] });
    const res = await runUpstream(udeps(p), dir, "Add X", async () => "x", 3);
    expect(res.kind).toBe("approved");
    if (res.kind === "approved") {
      expect(res.specPath).toBe(".hc/spec.md");
      expect(res.planPath).toBe(".hc/plan.md");
    }
    expect(await readFile(join(dir, ".hc/spec.md"), "utf8")).toBe("# spec");
    expect(await readFile(join(dir, ".hc/plan.md"), "utf8")).toBe("# plan");
  });

  it("if the spec isn't approved → rejected(spec)", async () => {
    const p = upstreamProvider({ intent: "feature", judge: ['{"decision":"revise","feedback":["a"],"question":""}'] });
    const res = await runUpstream(udeps(p), dir, "Add X", async () => "stop", 1);
    expect(res.kind).toBe("rejected");
    if (res.kind === "rejected") expect(res.stage).toBe("spec");
  });

  it("emits a refined event with the refined prompt before running downstream", async () => {
    const p = upstreamProvider({ intent: "chat" });
    const events: { kind: string; refinedPrompt?: string }[] = [];
    await runUpstream(udeps(p), dir, "hello", async () => "x", 3, [], (ev) => events.push(ev));
    expect(events).toContainEqual({ kind: "refined", refinedPrompt: "Do X" });
  });

  it("throws if cancelled", async () => {
    const ac = new AbortController(); ac.abort();
    const p = upstreamProvider({ intent: "feature" });
    await expect(runUpstream(udeps(p, ac.signal), dir, "X", async () => "x", 2)).rejects.toThrow();
  });

  it("throws if the analyst doesn't produce a spec file (even if the judge still passes it)", async () => {
    const p = upstreamProvider({ intent: "feature", skipWrite: true, judge: ['{"decision":"pass","feedback":[],"question":""}'] });
    await expect(runUpstream(udeps(p), dir, "X", async () => "x", 1)).rejects.toThrow(/spec/);
  });
});
