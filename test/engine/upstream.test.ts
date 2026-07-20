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

// İçerik-tabanlı provider: systemPrompt (rol) + tool-mesajlarına göre yanıt; requests yakalar.
export function upstreamProvider(opts: { intent?: string; judge?: string[]; analystAsk?: string } = {}): Provider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let judgeCall = 0;
  return {
    requests,
    async *chat(req) {
      requests.push(req);
      const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      const toolMsgs = req.messages.filter((m) => m.role === "tool");
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
      if (sys.includes("P-refiner")) { yield* submit(`{"refinedPrompt":"X yap","intent":"${opts.intent ?? "feature"}"}`); return; }
      if (sys.includes("P-coach")) { yield* stop("coach cevabı"); return; }
      if (sys.includes("P-analyst")) {
        if (opts.analystAsk && toolMsgs.length === 0) { yield* call("ask_user", JSON.stringify({ question: opts.analystAsk })); return; }
        if (!toolMsgs.some((m) => m.name === "write_file")) { yield* call("write_file", JSON.stringify({ path: "spec.md", content: "# spec" })); return; }
        yield* stop("bitti"); return;
      }
      if (sys.includes("P-planner")) {
        if (!toolMsgs.some((m) => m.name === "write_file")) { yield* call("write_file", JSON.stringify({ path: "plan.md", content: "# plan" })); return; }
        yield* stop("bitti"); return;
      }
      if (sys.includes("Perspektif")) { yield* submit('{"concerns":[],"recommendation":"approve"}'); return; }
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
  const councilors: CouncilorConfig[] = [{ name: "sec", perspective: "güvenlik", models: ["m"] }];
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
  it("askUser'ı çağırır, cevabı content'te döner", async () => {
    let asked = "";
    const t = buildAskUserTool(async (q) => { asked = q; return "cevabım"; });
    const res = await t.run({ question: "X mi?" }, ctx());
    expect(asked).toBe("X mi?");
    expect(res.content).toBe("cevabım");
    expect(res.isError).toBe(false);
  });

  it("geçersiz args → isError", async () => {
    const t = buildAskUserTool(async () => "x");
    const res = await t.run({}, ctx());
    expect(res.isError).toBe(true);
  });
});

describe("runAnalyst", () => {
  it("spec dosyasını yazar; toolset ask_user+write içerir, shell yok", async () => {
    const p = upstreamProvider({});
    await runAnalyst(udeps(p), dir, "spec.md", "X yap", undefined, async () => "x");
    expect(await readFile(join(dir, "spec.md"), "utf8")).toBe("# spec");
    const names = p.requests[0].tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["ask_user", "write_file", "read_file", "grep", "glob", "skill"]));
    expect(names).not.toContain("shell");
    expect(names).not.toContain("web_fetch");
  });

  it("feedback doluysa istekte notlar geçer (revize)", async () => {
    const p = upstreamProvider({});
    await runAnalyst(udeps(p), dir, "spec.md", "X yap", ["testsiz kalmış"], async () => "x");
    const userMsg = p.requests[0].messages.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).toContain("testsiz kalmış");
  });

  it("analyst ask_user çağırırsa askUser tetiklenir", async () => {
    const p = upstreamProvider({ analystAsk: "X mi Y mi?" });
    let asked = "";
    await runAnalyst(udeps(p), dir, "spec.md", "X yap", undefined, async (q) => { asked = q; return "X"; });
    expect(asked).toBe("X mi Y mi?");
    expect(await readFile(join(dir, "spec.md"), "utf8")).toBe("# spec");
  });
});

describe("runPlanner", () => {
  it("plan dosyasını yazar; toolset write var, ask_user yok", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = upstreamProvider({});
    await runPlanner(udeps(p), dir, "plan.md", "spec.md", undefined);
    expect(await readFile(join(dir, "plan.md"), "utf8")).toBe("# plan");
    const names = p.requests[0].tools.map((t) => t.name);
    expect(names).toContain("write_file");
    expect(names).not.toContain("ask_user");
  });

  it("feedback doluysa istekte notlar geçer", async () => {
    await writeFile(join(dir, "spec.md"), "# spec", "utf8");
    const p = upstreamProvider({});
    await runPlanner(udeps(p), dir, "plan.md", "spec.md", ["dalga eksik"]);
    const userMsg = p.requests[0].messages.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).toContain("dalga eksik");
  });
});

describe("runUpstream", () => {
  it("chat intent → coach cevabı", async () => {
    const p = upstreamProvider({ intent: "chat" });
    const res = await runUpstream(udeps(p), dir, "merhaba", async () => "x", 3);
    expect(res.kind).toBe("chat");
    if (res.kind === "chat") expect(res.response).toBe("coach cevabı");
    expect(res.intent).toBe("chat");
  });

  it("feature → spec+plan onaylanır → approved, iki dosya yazılı", async () => {
    const p = upstreamProvider({ intent: "feature", judge: ['{"decision":"pass","feedback":[],"question":""}', '{"decision":"pass","feedback":[],"question":""}'] });
    const res = await runUpstream(udeps(p), dir, "X ekle", async () => "x", 3);
    expect(res.kind).toBe("approved");
    if (res.kind === "approved") {
      expect(res.specPath).toBe("spec.md");
      expect(res.planPath).toBe("plan.md");
    }
    expect(await readFile(join(dir, "spec.md"), "utf8")).toBe("# spec");
    expect(await readFile(join(dir, "plan.md"), "utf8")).toBe("# plan");
  });

  it("spec onaylanmazsa → rejected(spec)", async () => {
    const p = upstreamProvider({ intent: "feature", judge: ['{"decision":"revise","feedback":["a"],"question":""}'] });
    const res = await runUpstream(udeps(p), dir, "X ekle", async () => "durdur", 1);
    expect(res.kind).toBe("rejected");
    if (res.kind === "rejected") expect(res.stage).toBe("spec");
  });

  it("iptal edilmişse fırlatır", async () => {
    const ac = new AbortController(); ac.abort();
    const p = upstreamProvider({ intent: "feature" });
    await expect(runUpstream(udeps(p, ac.signal), dir, "X", async () => "x", 2)).rejects.toThrow();
  });
});
