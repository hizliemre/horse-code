import { describe, it, expect } from "vitest";
import { memoryHints, reinforceUsed } from "../../src/engine/memory-inject.js";
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
    expect(memoryHints(deps([]), "anything")).toEqual({ message: "", ids: [] });
    expect(memoryHints({} as TaskCycleDeps, "anything")).toEqual({ message: "", ids: [] });
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
