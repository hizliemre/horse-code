import { describe, it, expect } from "vitest";
import { duplicateCandidates, dedupeMemories, applyMerges, CANDIDATE_BAR } from "../../src/engine/memory-dedupe.js";
import { deriveAnchors, deriveTags, type MemoryEntry } from "../../src/engine/memory-retrieval.js";
import type { Provider } from "../../src/core/types.js";

const entry = (id: string, text: string, kind: MemoryEntry["kind"] = "fact"): MemoryEntry => {
  const anchors = deriveAnchors(text);
  return { id, text, anchors, tags: deriveTags(text, anchors), createdAt: 1, kind, uses: 0 };
};
const canned = (text: string): Provider => ({
  chat: async function* () { yield { type: "text-delta" as const, text }; },
} as unknown as Provider);

/**
 * `hygiene` merges entries whose TEXT normalizes alike, which catches a fact saved twice verbatim. It cannot
 * catch what happens when work runs in parallel: two tasks discover the same thing and write it in their own
 * words, so the pool grows a pair of near-twins for every shared discovery.
 */
describe("duplicateCandidates — the cheap pass that decides what is worth asking about", () => {
  it("groups two wordings of one claim about the same file", () => {
    const a = entry("a", "Persistence goes through `DataServicePort` in src/app/core/ports.ts");
    const b = entry("b", "All persistence calls must use `DataServicePort` (src/app/core/ports.ts)");
    expect(duplicateCandidates([a, b])[0]?.ids).toEqual(["a", "b"]);
  });

  it("never groups across kinds — a lesson and a fact are different claims", () => {
    const a = entry("a", "Persistence goes through `DataServicePort` in src/app/core/ports.ts", "fact");
    const b = entry("b", "Persistence goes through `DataServicePort` in src/app/core/ports.ts", "lesson");
    expect(duplicateCandidates([a, b])).toEqual([]);
  });

  it("leaves unrelated notes ungrouped", () => {
    const a = entry("a", "Billing lives in src/billing.ts");
    const b = entry("b", "The cargo list sorts by `createdAt` in src/cargo/list.ts");
    expect(duplicateCandidates([a, b])).toEqual([]);
  });

  it("puts every member of a three-way pile in one group, not three pairs", () => {
    const t = "Never hardcode display text in src/ui/labels.ts";
    const g = duplicateCandidates([entry("a", t), entry("b", `${t} — use translation`), entry("c", `${t}!`)]);
    expect(g).toHaveLength(1);
    expect(g[0]!.ids).toEqual(["a", "b", "c"]);
  });
});

describe("dedupeMemories", () => {
  const PAIR = [
    entry("a", "Persistence goes through `DataServicePort` in src/app/core/ports.ts"),
    entry("b", "All persistence calls must use `DataServicePort` (src/app/core/ports.ts)"),
  ];

  it("returns the merge the model confirmed", async () => {
    const m = await dedupeMemories({
      provider: canned('```json\n{"merges":[{"group":0,"indexes":[0,1],"text":"Persistence goes through `DataServicePort` (src/app/core/ports.ts)"}]}\n```'),
      models: ["m"], entries: PAIR,
    });
    expect(m).toHaveLength(1);
    expect(m[0]!.ids).toEqual(["a", "b"]);
    expect(m[0]!.text).toContain("DataServicePort");
  });

  /** A wrong merge deletes something the project knew; two notes only cost a little context. */
  it("merges nothing when the model declines, or answers unreadably", async () => {
    for (const reply of ['```json\n{"merges":[]}\n```', "these look similar to me", '```json\n{"merges":[{"group":0,"indexes":[0]}]}\n```']) {
      expect(await dedupeMemories({ provider: canned(reply), models: ["m"], entries: PAIR })).toEqual([]);
    }
  });

  it("never invents an id that was not in the group", async () => {
    const m = await dedupeMemories({
      provider: canned('```json\n{"merges":[{"group":0,"indexes":[0,1,7],"text":"x"}]}\n```'),
      models: ["m"], entries: PAIR,
    });
    expect(m[0]!.ids).toEqual(["a", "b"]);
  });

  it("does not call a model at all when nothing is even a candidate", async () => {
    let called = false;
    const spy = { chat: async function* () { called = true; } } as unknown as Provider;
    expect(await dedupeMemories({ provider: spy, models: ["m"], entries: [entry("a", "Billing lives in src/billing.ts")] })).toEqual([]);
    expect(called).toBe(false);
  });

  it("slides past a spent model rather than reporting no duplicates", async () => {
    const calls: string[] = [];
    const provider = {
      chat: async function* (req: { model: string }) {
        calls.push(req.model);
        if (req.model === "dead") { yield { type: "error" as const, message: "quota" }; return; }
        yield { type: "text-delta" as const, text: '```json\n{"merges":[{"group":0,"indexes":[0,1],"text":"merged"}]}\n```' };
      },
    } as unknown as Provider;
    expect(await dedupeMemories({ provider, models: ["dead", "alive"], entries: PAIR })).toHaveLength(1);
    expect(calls).toEqual(["dead", "alive"]);
  });
});

describe("applyMerges", () => {
  it("keeps the first, rewrites it, and drops the rest", () => {
    const pool = [entry("a", "one"), entry("b", "two"), entry("c", "unrelated")];
    const r = applyMerges(pool, [{ ids: ["a", "b"], text: "one and two" }]);
    expect(r.removed).toBe(1);
    expect(r.entries.map((e) => e.id)).toEqual(["a", "c"]);
    expect(r.entries[0]!.text).toBe("one and two");
  });

  /** Both entries measured the same claim being useful; tidying up must not make it look untested. */
  it("carries the absorbed entries' usage onto the keeper", () => {
    const a = { ...entry("a", "one"), uses: 2, injections: 5, observedInjections: 4 };
    const b = { ...entry("b", "two"), uses: 3, injections: 7, observedInjections: 6 };
    const r = applyMerges([a, b], [{ ids: ["a", "b"], text: "merged" }]);
    expect(r.entries[0]).toMatchObject({ uses: 5, injections: 12, observedInjections: 10 });
  });

  it("ignores a merge naming an entry that is gone", () => {
    const pool = [entry("a", "one")];
    expect(applyMerges(pool, [{ ids: ["a", "missing"], text: "x" }]).removed).toBe(0);
  });
});
