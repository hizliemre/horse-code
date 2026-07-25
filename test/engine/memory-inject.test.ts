import { describe, it, expect } from "vitest";
import { memoryHints, reinforceUsed, emitBatchInjection, memoryNote, type MemoryEvent } from "../../src/engine/memory-inject.js";
import type { MemoryEntry } from "../../src/engine/memory-retrieval.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";

const mem = (over: Partial<MemoryEntry> & { id: string; text: string }): MemoryEntry =>
  ({ anchors: [], tags: [], createdAt: 0, ...over });

const deps = (entries: MemoryEntry[], reinforce?: (id: string) => void): TaskCycleDeps =>
  ({ memory: () => entries, ...(reinforce ? { reinforceMemory: reinforce } : {}) } as unknown as TaskCycleDeps);

describe("memoryHints (memory for every role, not just the coach)", () => {
  it("returns the relevant facts/lessons as an injectable message", () => {
    const entries = [
      mem({ id: "a", text: "the store adapter lives in src/store.ts", anchors: ["src/store.ts"], tags: ["store"] }),
      mem({ id: "b", text: "unrelated note about billing", anchors: ["src/billing.ts"], tags: ["billing"] }),
    ];
    const { message, ids } = memoryHints(deps(entries), "refactor src/store.ts persistence");
    expect(ids).toEqual(["a"]);
    expect(message).toContain("src/store.ts");
    expect(message).not.toContain("billing");
  });

  it("never re-injects RULES — they already ride every system prompt", () => {
    const entries = [mem({ id: "r", text: "always answer in Turkish", kind: "rule", tags: ["turkish"] })];
    expect(memoryHints(deps(entries), "answer in turkish please").ids).toEqual([]);
  });

  it("is a no-op when there is no memory at all", () => {
    for (const d of [deps([]), {} as TaskCycleDeps]) {
      const r = memoryHints(d, "anything");
      expect(r.message).toBe("");
      expect(r.ids).toEqual([]);
      expect(r.hits).toEqual([]);
    }
  });
});

describe("reinforceUsed", () => {
  it("credits only the memories the output actually referenced", () => {
    const entries = [
      mem({ id: "a", text: "the store adapter lives in src/store.ts", anchors: ["src/store.ts"] }),
      mem({ id: "b", text: "billing uses src/billing.ts", anchors: ["src/billing.ts"] }),
    ];
    const bumped: string[] = [];
    reinforceUsed(deps(entries, (id) => bumped.push(id)), ["a", "b"], "I updated src/store.ts as noted.");
    expect(bumped).toEqual(["a"]);
  });
});

describe("cooldown through memoryHints", () => {
  it("the same memory is not re-injected on the next call for the same topic", async () => {
    const { InjectionLog } = await import("../../src/engine/memory-retrieval.js");
    const entries = [mem({ id: "a", text: "the store adapter lives in src/store.ts", anchors: ["src/store.ts"], tags: ["store"] })];
    const d = { memory: () => entries, injectionLog: new InjectionLog() } as unknown as TaskCycleDeps;
    expect(memoryHints(d, "touching src/store.ts").ids).toEqual(["a"]); // first time: injected
    expect(memoryHints(d, "touching src/store.ts").ids).toEqual([]);    // still fresh in context
  });
});

// ── Observability ─────────────────────────────────────────────────────────────────────────────────────────
// Injection used to be entirely invisible: "no memory applied" and "memory is broken" looked identical, and
// there was no way to tell whether an injected hint was ever actually used.
describe("memory events", () => {
  const withSinks = (entries: MemoryEntry[]) => {
    const events: MemoryEvent[] = [];
    const injected: string[][] = [];
    const d = {
      memory: () => entries,
      onMemory: (ev: MemoryEvent) => events.push(ev),
      recordInjection: (ids: string[]) => injected.push(ids),
      reinforceMemory: () => {},
    } as unknown as TaskCycleDeps;
    return { d, events, injected };
  };
  const store = mem({ id: "a", text: "the store adapter lives in src/store.ts", anchors: ["src/store.ts"], tags: ["store"] });

  it("reports what was injected, for which role", () => {
    const { d, events } = withSinks([store]);
    memoryHints(d, "refactor src/store.ts", { role: "coder" });
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.kind).toBe("injected");
    if (ev.kind === "injected") {
      expect(ev.role).toBe("coder");
      expect(ev.hits.map((h) => h.entry.id)).toEqual(["a"]);
    }
  });

  it("records a durable injection count so 'never relevant' can be told from 'never came up'", () => {
    const { d, injected } = withSinks([store]);
    memoryHints(d, "refactor src/store.ts", { role: "coder" });
    expect(injected).toEqual([["a"]]);
  });

  it("emits nothing when nothing was selected — silence is not a report", () => {
    const { d, events, injected } = withSinks([store]);
    memoryHints(d, "a completely unrelated question", { role: "coder" });
    expect(events).toEqual([]);
    expect(injected).toEqual([]);
  });

  it("silent callers get the hints without the note (fan-outs report once, not per member)", () => {
    const { d, events } = withSinks([store]);
    const r = memoryHints(d, "refactor src/store.ts", { role: "coder", silent: true });
    expect(r.ids).toEqual(["a"]);
    expect(events).toEqual([]);
  });

  it("emitBatchInjection folds a fan-out into one event", () => {
    const { d, events } = withSinks([store]);
    const parts = ["lens-a", "lens-b"].map((role) => memoryHints(d, "refactor src/store.ts", { role, silent: true }));
    emitBatchInjection(d, "team:code", parts);
    expect(events).toHaveLength(1);
    if (events[0].kind === "injected") {
      expect(events[0].role).toBe("team:code");
      // The pool is the same pool seen twice, not two pools.
      expect(events[0].stats.considered).toBe(1);
    }
  });

  it("does nothing when the fan-out selected nothing at all", () => {
    const { d, events } = withSinks([store]);
    emitBatchInjection(d, "team:code", [memoryHints(d, "unrelated", { role: "x", silent: true })]);
    expect(events).toEqual([]);
  });

  it("reports a memory that actually paid off", () => {
    const { d, events } = withSinks([store]);
    reinforceUsed(d, ["a"], "I updated src/store.ts as noted", "coder");
    expect(events).toEqual([{ kind: "used", role: "coder", texts: [store.text] }]);
  });

  it("stays quiet when the output never referenced the hint", () => {
    const { d, events } = withSinks([store]);
    reinforceUsed(d, ["a"], "I did something else entirely", "coder");
    expect(events).toEqual([]);
  });
});

describe("memoryNote", () => {
  const hit = (id: string, text: string, via: "query" | "graph" = "query") =>
    ({ entry: mem({ id, text }), relevance: 0.9, score: 0.9, via } as const);
  const stats = { considered: 5, belowThreshold: 0, cooldown: 2, audience: 1, inactive: 0, budget: 0 };

  it("names the role, the count and why the rest was skipped", () => {
    const note = memoryNote({ kind: "injected", role: "coder", hits: [hit("a", "use pnpm")], stats });
    expect(note).toContain("coder");
    expect(note).toContain("1 hint");
    expect(note).toContain("2 on cooldown");
    expect(note).toContain("1 for other roles");
  });

  it("marks a graph-sourced hint so an unexpected memory is explainable", () => {
    expect(memoryNote({ kind: "injected", role: "coder", hits: [hit("a", "x", "graph")], stats })).toContain("🔗");
  });

  it("has nothing to say about an empty injection", () => {
    expect(memoryNote({ kind: "injected", role: "coder", hits: [], stats })).toBeUndefined();
  });

  it("reports hygiene and extraction", () => {
    expect(memoryNote({ kind: "hygiene", merged: 2, candidates: 1 })).toContain("merged 2 duplicate");
    expect(memoryNote({ kind: "hygiene", merged: 0, candidates: 0 })).toBeUndefined();
    expect(memoryNote({ kind: "learned", texts: ["a lesson"] })).toContain("a lesson");
  });

  it("clips long memory text so one note cannot swallow the transcript", () => {
    const note = memoryNote({ kind: "injected", role: "coder", hits: [hit("a", "x".repeat(500))], stats });
    expect(note!.length).toBeLessThan(300);
  });
});
