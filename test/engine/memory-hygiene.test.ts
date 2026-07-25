import { describe, it, expect } from "vitest";
import { hygiene, hygieneSummary, normalizeTextKey, REVIEW_AGE_MS, STALE_AGE_MS, UNUSED_INJECTIONS } from "../../src/engine/memory-hygiene.js";
import type { MemoryEntry } from "../../src/engine/memory-retrieval.js";

const NOW = 1_000_000_000_000;
const mem = (over: Partial<MemoryEntry> & { id: string; text: string }): MemoryEntry =>
  ({ anchors: [], tags: [], createdAt: NOW, ...over });

describe("normalizeTextKey", () => {
  it("treats the same claim written differently as one claim", () => {
    expect(normalizeTextKey("Use pnpm, not npm!")).toBe(normalizeTextKey("use pnpm  not npm"));
  });
  it("keeps genuinely different claims apart", () => {
    expect(normalizeTextKey("use pnpm")).not.toBe(normalizeTextKey("use npm"));
  });
});

describe("hygiene — deduplication", () => {
  it("merges same-claim memories into one", () => {
    const r = hygiene([
      mem({ id: "a", text: "the API base is /v2" }),
      mem({ id: "b", text: "The API base is /v2." }),
    ], NOW);
    expect(r.entries).toHaveLength(1);
    expect(r.merged).toEqual([{ keeper: "a", absorbed: ["The API base is /v2."] }]);
  });

  it("does NOT merge across kinds — a fact and a lesson that read alike are different claims", () => {
    const r = hygiene([
      mem({ id: "a", text: "migrations run on boot", kind: "fact" }),
      mem({ id: "b", text: "migrations run on boot", kind: "lesson" }),
    ], NOW);
    expect(r.entries).toHaveLength(2);
    expect(r.merged).toEqual([]);
  });

  it("keeps the most important, then most cited, then the one established first", () => {
    const r = hygiene([
      mem({ id: "new", text: "same claim", createdAt: NOW, uses: 5 }),
      mem({ id: "old", text: "same claim", createdAt: NOW - 1000, uses: 5 }),
    ], NOW);
    expect(r.entries[0].id).toBe("old");

    const byUses = hygiene([
      mem({ id: "quiet", text: "same claim", createdAt: 1, uses: 0 }),
      mem({ id: "cited", text: "same claim", createdAt: 2, uses: 4 }),
    ], NOW);
    expect(byUses.entries[0].id).toBe("cited");
  });

  // A merge that dropped the loser's reach would make the survivor match fewer queries than the pair did.
  it("the survivor absorbs the union of anchors and tags", () => {
    const r = hygiene([
      mem({ id: "a", text: "same claim", anchors: ["src/a.ts"], tags: ["auth"] }),
      mem({ id: "b", text: "same claim", anchors: ["src/b.ts"], tags: ["login"] }),
    ], NOW);
    expect(r.entries[0].anchors.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(r.entries[0].tags.sort()).toEqual(["auth", "login"]);
  });

  // Without this a dedup would silently reset a well-used memory's stats and set it up to be flagged as noise.
  it("the survivor absorbs usage evidence rather than discarding it", () => {
    const r = hygiene([
      mem({ id: "a", text: "same claim", uses: 3, injections: 8 }),
      mem({ id: "b", text: "same claim", uses: 2, injections: 5 }),
    ], NOW);
    expect(r.entries[0].uses).toBe(5);
    expect(r.entries[0].injections).toBe(13);
  });

  it("a permanent duplicate makes the survivor permanent", () => {
    const r = hygiene([
      mem({ id: "a", text: "same claim", persistence: "long", importance: 0.9 }),
      mem({ id: "b", text: "same claim", persistence: "permanent" }),
    ], NOW);
    expect(r.entries[0].persistence).toBe("permanent");
  });

  it("leaves a pool with no duplicates untouched", () => {
    const pool = [mem({ id: "a", text: "one" }), mem({ id: "b", text: "two" })];
    const r = hygiene(pool, NOW);
    expect(r.entries).toEqual(pool);
    expect(r.merged).toEqual([]);
  });
});

describe("hygiene — review candidates", () => {
  const old = NOW - REVIEW_AGE_MS - 1;

  it("flags an entry that keeps being injected and is never cited", () => {
    const r = hygiene([mem({ id: "a", text: "noise", createdAt: old, injections: UNUSED_INJECTIONS, uses: 0 })], NOW);
    expect(r.candidates).toEqual([{ id: "a", text: "noise", reason: "injected-never-used" }]);
  });

  it("does not flag it before it has had time to prove itself", () => {
    expect(hygiene([mem({ id: "a", text: "noise", createdAt: NOW, injections: 50, uses: 0 })], NOW).candidates).toEqual([]);
  });

  it("does not flag one that IS cited, however often it was shown", () => {
    expect(hygiene([mem({ id: "a", text: "useful", createdAt: old, injections: 99, uses: 1 })], NOW).candidates).toEqual([]);
  });

  it("flags low-confidence and long-stale entries, and expired ones immediately", () => {
    const r = hygiene([
      mem({ id: "lc", text: "shaky", createdAt: old, confidence: 0.3 }),
      mem({ id: "st", text: "rotted", createdAt: NOW - STALE_AGE_MS - 1, stale: true }),
      mem({ id: "ex", text: "gone", expiresAt: NOW - 1 }),
    ], NOW);
    expect(r.candidates.map((c) => c.reason).sort()).toEqual(["expired", "long-stale", "low-confidence"]);
  });

  it("never flags a permanent memory — it was marked never-to-lapse", () => {
    const r = hygiene([
      mem({ id: "p", text: "rule", persistence: "permanent", createdAt: old, injections: 99, uses: 0, confidence: 0.1, stale: true }),
    ], NOW);
    expect(r.candidates).toEqual([]);
  });

  // The whole point of the candidate list: this file is the only copy, so an automatic delete is unrecoverable.
  it("flagging NEVER removes the entry", () => {
    const r = hygiene([mem({ id: "a", text: "gone", expiresAt: NOW - 1 })], NOW);
    expect(r.candidates).toHaveLength(1);
    expect(r.entries.map((e) => e.id)).toEqual(["a"]);
  });
});

describe("hygieneSummary", () => {
  it("is undefined when the run changed nothing", () => {
    expect(hygieneSummary({ entries: [], merged: [], candidates: [] })).toBeUndefined();
  });
  it("counts absorbed duplicates, not merge groups", () => {
    const s = hygieneSummary({ entries: [], merged: [{ keeper: "a", absorbed: ["x", "y"] }], candidates: [] });
    expect(s).toContain("2 duplicate");
  });
});
