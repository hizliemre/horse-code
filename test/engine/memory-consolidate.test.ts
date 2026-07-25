import { describe, it, expect } from "vitest";
import {
  consolidateJob, buildEvidence, looksSecret, redact, sanitizeAudience,
  MAX_LEARNED, MAX_EVIDENCE_CHARS, EXTRACTED_CONFIDENCE,
} from "../../src/engine/memory-consolidate.js";
import { Board, type Card } from "../../src/board/board.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { fakeSpecKit } from "../support/fake-speckit.js";
import type { Provider } from "../../src/core/types.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";
import type { MemoryEvent } from "../../src/engine/memory-inject.js";

interface Learned { text: string; kind: "fact" | "lesson"; audience?: string[]; importance?: number }
type LearnOpts = { learnedBy: string; audience?: string[]; importance?: number; confidence?: number };

const submits = (memories: Learned[]): Provider => ({
  async *chat() {
    yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: JSON.stringify({ memories }) } };
    yield { type: "done", finishReason: "tool_calls" };
  },
});
const silent: Provider = { async *chat() { yield { type: "done", finishReason: "stop" }; } };

function deps(provider: Provider, sink: { text: string; kind: string; opts: LearnOpts }[], events: MemoryEvent[] = [], withRole = true): TaskCycleDeps {
  return {
    provider,
    roleRegistry: new RoleRegistry(withRole ? { "memory-keeper": { models: ["m"], systemPrompt: "P" } } : {}, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: new AbortController().signal,
    specKit: fakeSpecKit,
    learnMemory: async (text: string, kind: string, opts: LearnOpts) => { sink.push({ text, kind, opts }); return true; },
    onMemory: (ev: MemoryEvent) => events.push(ev),
  } as unknown as TaskCycleDeps;
}

const cards = (over: Partial<Card> = {}): Card[] => {
  const b = new Board();
  b.addCard({ id: "t1", title: "add auth" });
  const c = b.get("t1")!;
  return [{ ...c, ...over }];
};

describe("secret guard (memory.jsonl is committed with the repo)", () => {
  it.each([
    ["sk-37d3edbe1d5d9beb089776052ac0b9"],
    ["ghp_abcdefghijklmnopqrstuvwxyz012345"],
    ["the api_key = hunter2sure"],
    ["Authorization: Bearer abc123def456"],
    ["-----BEGIN RSA PRIVATE KEY-----"],
  ])("rejects %s", (s) => expect(looksSecret(s)).toBe(true));

  it("passes ordinary project prose", () => {
    expect(looksSecret("auth tokens are validated in src/auth.ts")).toBe(false);
    expect(looksSecret("use pnpm, never npm")).toBe(false);
  });

  it("redacts the whole line — a partial mask still leaks length and prefix", () => {
    const out = redact("safe line\napi_key = supersecretvalue\nother safe");
    expect(out).toBe("safe line\n[redacted]\nother safe");
  });
});

describe("buildEvidence", () => {
  it("carries the signal: attempt counts and what reviewers sent back", () => {
    const ev = buildEvidence({ request: "add auth", cards: cards({ attempts: 3, reviewNotes: ["missing csrf check"] }) });
    expect(ev).toContain("took 3 attempts");
    expect(ev).toContain("missing csrf check");
  });

  it("omits an attempt count for a task that passed first time — it teaches nothing", () => {
    expect(buildEvidence({ request: "x", cards: cards({ attempts: 1 }) })).not.toContain("attempts");
  });

  it("skips synthetic cards (the revision pass is not a work item)", () => {
    const b = new Board();
    b.addCard({ id: "__revision__", title: "PR revision" });
    expect(buildEvidence({ request: "x", cards: b.list() })).not.toContain("PR revision");
  });

  it("redacts secrets a reviewer note happened to quote, and stays within budget", () => {
    const ev = buildEvidence({ request: "x", cards: cards({ reviewNotes: ["token = ghp_abcdefghijklmnopqrstuvwxyz012345"] }) });
    expect(ev).not.toContain("ghp_");
    const big = buildEvidence({ request: "x".repeat(50_000), cards: cards() });
    expect(big.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
  });
});

describe("sanitizeAudience", () => {
  const known = new Set(["coder", "code-security"]);
  it("keeps real roles", () => expect(sanitizeAudience(["coder"], known)).toEqual(["coder"]));
  // An invented audience would address the memory to nobody — worse than leaving it unscoped.
  it("drops invented roles rather than hiding the memory from everyone", () => {
    expect(sanitizeAudience(["backend-dev"], known)).toBeUndefined();
    expect(sanitizeAudience(["backend-dev", "coder"], known)).toEqual(["coder"]);
  });
  it("treats an absent audience as unscoped", () => expect(sanitizeAudience(undefined, known)).toBeUndefined());
});

describe("consolidateJob", () => {
  it("stores what the job taught, below user-stated confidence", async () => {
    const sink: { text: string; kind: string; opts: LearnOpts }[] = [];
    const stored = await consolidateJob(
      deps(submits([{ text: "csrf tokens are required on every POST", kind: "lesson" }]), sink),
      { request: "add auth", cards: cards({ attempts: 3 }) }, "/tmp",
    );
    expect(stored).toEqual(["csrf tokens are required on every POST"]);
    expect(sink[0].kind).toBe("lesson");
    expect(sink[0].opts.learnedBy).toBe("memory-keeper");
    // It is inferring, not transcribing — it must never outrank what the user said themselves.
    expect(sink[0].opts.confidence).toBe(EXTRACTED_CONFIDENCE);
    expect(EXTRACTED_CONFIDENCE).toBeLessThan(0.9);
  });

  it("an empty extraction is a normal outcome, not a failure", async () => {
    const sink: { text: string; kind: string; opts: LearnOpts }[] = [];
    expect(await consolidateJob(deps(submits([]), sink), { request: "x", cards: cards() }, "/tmp")).toEqual([]);
    expect(sink).toEqual([]);
  });

  it("caps how much one job may add", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ text: `memory ${i}`, kind: "fact" as const }));
    const sink: { text: string; kind: string; opts: LearnOpts }[] = [];
    const stored = await consolidateJob(deps(submits(many), sink), { request: "x", cards: cards() }, "/tmp");
    expect(stored).toHaveLength(MAX_LEARNED);
  });

  // The prompt forbids secrets; an unsupervised writer is never trusted on its own word.
  it("refuses to store a secret even when the model returns one", async () => {
    const sink: { text: string; kind: string; opts: LearnOpts }[] = [];
    const stored = await consolidateJob(deps(submits([
      { text: "the omniroute key is sk-37d3edbe1d5d9beb089776052ac0b9", kind: "fact" },
      { text: "the api base is /v2", kind: "fact" },
    ]), sink), { request: "x", cards: cards() }, "/tmp");
    expect(stored).toEqual(["the api base is /v2"]);
    expect(sink.map((s) => s.text)).not.toContain(expect.stringContaining("sk-"));
  });

  it("validates the audience against real role names", async () => {
    const sink: { text: string; kind: string; opts: LearnOpts }[] = [];
    await consolidateJob(
      deps(submits([{ text: "a", kind: "fact", audience: ["coder", "made-up"] }]), sink),
      { request: "x", cards: cards() }, "/tmp", ["coder"],
    );
    expect(sink[0].opts.audience).toEqual(["coder"]);
  });

  it("emits one learned event so the user sees what was written", async () => {
    const events: MemoryEvent[] = [];
    await consolidateJob(deps(submits([{ text: "a durable fact", kind: "fact" }]), [], events),
      { request: "x", cards: cards() }, "/tmp");
    expect(events).toEqual([{ kind: "learned", texts: ["a durable fact"] }]);
  });

  // Memory is advisory: a failed extraction must never turn a finished job into a failed one.
  it("swallows a model that never submits", async () => {
    expect(await consolidateJob(deps(silent, []), { request: "x", cards: cards() }, "/tmp")).toEqual([]);
  });

  it("skips silently when the role is not configured", async () => {
    const sink: { text: string; kind: string; opts: LearnOpts }[] = [];
    expect(await consolidateJob(deps(submits([{ text: "a", kind: "fact" }]), sink, [], false), { request: "x", cards: cards() }, "/tmp")).toEqual([]);
  });

  it("does nothing when no real task ran", async () => {
    const b = new Board();
    b.addCard({ id: "__revision__", title: "PR revision" });
    expect(await consolidateJob(deps(submits([{ text: "a", kind: "fact" }]), []), { request: "x", cards: b.list() }, "/tmp")).toEqual([]);
  });

  it("is inert without a memory sink wired", async () => {
    const d = deps(submits([{ text: "a", kind: "fact" }]), []);
    delete (d as { learnMemory?: unknown }).learnMemory;
    expect(await consolidateJob(d, { request: "x", cards: cards() }, "/tmp")).toEqual([]);
  });
});
