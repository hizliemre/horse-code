import { describe, it, expect } from "vitest";
import { deriveAnchors, deriveTags, scoreMemory, hintBudget, selectMemories, renderMemoryHints, supersedes, memoryReferenced, type MemoryEntry, fileAnchors, hashAnchors, verifyAnchors, type AnchorFs, isExpired, audienceMatches } from "../../src/engine/memory-retrieval.js";

const entry = (id: string, text: string, over: Partial<MemoryEntry> = {}): MemoryEntry => {
  const anchors = over.anchors ?? deriveAnchors(text);
  return { id, text, anchors, tags: over.tags ?? deriveTags(text, anchors), createdAt: over.createdAt ?? 1 };
};

describe("deriveAnchors", () => {
  it("captures paths, files, backticked terms, camel/snake identifiers", () => {
    const a = deriveAnchors("edit `useAuth` in src/auth/login.ts and update auth_config");
    expect(a).toContain("useauth");
    expect(a).toContain("src/auth/login.ts");
    expect(a).toContain("auth_config");
  });
});

describe("deriveTags", () => {
  it("keeps informative words, drops stopwords and anchors", () => {
    const anchors = deriveAnchors("deploy to staging");
    const tags = deriveTags("always deploy to staging environment", anchors);
    expect(tags).toContain("deploy");
    expect(tags).toContain("staging");
    expect(tags).toContain("environment");
    expect(tags).not.toContain("the");
    expect(tags).not.toContain("use");
  });
});

describe("scoreMemory", () => {
  it("anchor appearing in the query dominates", () => {
    const e = entry("1", "the login flow lives in src/auth/login.ts");
    expect(scoreMemory("please fix src/auth/login.ts", e)).toBe(0.96);
  });
  it("two tag hits corroborate; one is weak; none is zero", () => {
    const e = entry("2", "prefer staging deploy pipeline");
    expect(scoreMemory("run the staging deploy now", e)).toBe(0.88); // staging + deploy
    expect(scoreMemory("staging only", e)).toBe(0.6); // one tag
    expect(scoreMemory("totally unrelated question", e)).toBe(0);
  });
});

describe("hintBudget", () => {
  it("shrinks the injection budget as context pressure rises", () => {
    expect(hintBudget(0.5, 5)).toBe(5);
    expect(hintBudget(0.7, 5)).toBe(3);
    expect(hintBudget(0.85, 5)).toBe(1);
    expect(hintBudget(0.97, 5)).toBe(0);
  });
});

describe("selectMemories", () => {
  it("returns the most relevant entries, capped by the pressure-gated budget", () => {
    const entries = [
      entry("a", "config lives in config/app.json"),
      entry("b", "prefer pnpm over npm for installs"),
      entry("c", "totally irrelevant note about cats"),
    ];
    const hits = selectMemories(entries, "update config/app.json with pnpm settings", { load: 0.1 });
    expect(hits.map((e) => e.id)).toContain("a"); // anchor match
    expect(hits.map((e) => e.id)).not.toContain("c"); // no match
    expect(selectMemories(entries, "update config/app.json", { load: 0.97 })).toEqual([]); // budget 0
  });
});

describe("supersedes", () => {
  it("a newer same-topic fact supersedes an older one (strong tag overlap)", () => {
    const oldF = entry("1", "the api base url is https://old.example.com");
    const newF = entry("2", "the api base url is https://new.example.com");
    expect(supersedes(newF, oldF)).toBe(true);
  });
  it("does not supersede unrelated facts that merely share a file anchor", () => {
    const a = entry("1", "prefer pnpm in src/app.ts");
    const b = entry("2", "run the linter before commit in src/app.ts");
    expect(supersedes(b, a)).toBe(false);
  });
});

describe("memoryReferenced", () => {
  it("true when the reply cites the memory's anchor or ≥2 tags", () => {
    const e = entry("1", "the parser lives in src/parser.ts");
    expect(memoryReferenced(e, "I updated src/parser.ts as noted")).toBe(true);
    expect(memoryReferenced(e, "here is an unrelated answer")).toBe(false);
  });
});

describe("selectMemories reinforcement tiebreak", () => {
  it("prefers the more-used memory when scores tie", () => {
    const a: MemoryEntry = { ...entry("a", "deploy pipeline runs on push"), uses: 5 };
    const b: MemoryEntry = { ...entry("b", "deploy pipeline caches deps"), uses: 0 };
    const hits = selectMemories([b, a], "the deploy pipeline", { load: 0.1, max: 1 });
    expect(hits[0].id).toBe("a"); // same score → higher uses wins
  });
});

describe("selectMemories lesson weighting", () => {
  it("a lesson outranks an equal-scored fact", () => {
    const f: MemoryEntry = { ...entry("f", "use the staging deploy pipeline"), kind: "fact" };
    const l: MemoryEntry = { ...entry("l", "the staging deploy pipeline needs a flag"), kind: "lesson" };
    const hits = selectMemories([f, l], "run the staging deploy", { load: 0.1, max: 2 });
    expect(hits[0].id).toBe("l"); // lesson gets the bonus → ranks first
  });
});

describe("renderMemoryHints", () => {
  it("renders a bulleted hint block", () => {
    const out = renderMemoryHints([entry("a", "use pnpm"), entry("b", "node 22")]);
    expect(out).toContain("Relevant notes from earlier sessions");
    expect(out).toContain("- use pnpm");
    expect(out).toContain("- node 22");
  });
});

describe("anchor verification (memory must not rot)", () => {
  const fs = (files: Record<string, string>): AnchorFs => ({ fingerprint: (p) => files[p] });

  it("picks out the anchors that are verifiable file paths", () => {
    expect(fileAnchors(["src/auth.ts", "validateToken", "pnpm test", "README.md"])).toEqual(["src/auth.ts", "README.md"]);
  });

  it("fingerprints existing file anchors only", () => {
    const h = hashAnchors(["src/a.ts", "src/gone.ts", "someSymbol"], fs({ "src/a.ts": "h1" }));
    expect(h).toEqual({ "src/a.ts": "h1" });
  });

  it("stays fresh while the anchored file is unchanged, goes stale when it changes or disappears", () => {
    const e: MemoryEntry = { id: "m1", text: "auth lives in src/auth.ts", anchors: ["src/auth.ts"], tags: [], createdAt: 0, anchorHashes: { "src/auth.ts": "h1" } };
    expect(verifyAnchors(e, fs({ "src/auth.ts": "h1" }))).toBe(true);
    expect(verifyAnchors(e, fs({ "src/auth.ts": "CHANGED" }))).toBe(false);
    expect(verifyAnchors(e, fs({}))).toBe(false); // file deleted
  });

  it("a memory with no verifiable anchor (a preference, a rule) is always fresh", () => {
    const e: MemoryEntry = { id: "m2", text: "prefer short names", anchors: [], tags: [], createdAt: 0 };
    expect(verifyAnchors(e, fs({}))).toBe(true);
  });

  it("stale memories are never selected for injection", () => {
    const fresh: MemoryEntry = { id: "a", text: "auth uses src/auth.ts jwt", anchors: ["src/auth.ts"], tags: ["jwt"], createdAt: 0 };
    const rotten: MemoryEntry = { ...fresh, id: "b", stale: true };
    const hits = selectMemories([rotten, fresh], "how does src/auth.ts work", { load: 0 });
    expect(hits.map((h) => h.id)).toEqual(["a"]);
  });
});

describe("audience scoping + persistence/TTL", () => {
  const base = { anchors: ["src/store.ts"], tags: ["store"], createdAt: 0 };
  const forAll: MemoryEntry = { ...base, id: "all", text: "the store adapter lives in src/store.ts" };
  const forReviewer: MemoryEntry = { ...base, id: "rev", text: "src/store.ts diffs need a migration note", audience: ["code-reviewer"] };

  it("an unscoped memory reaches every role; a scoped one only its audience", () => {
    const q = "changing src/store.ts";
    expect(selectMemories([forAll, forReviewer], q, { load: 0, role: "coder" }).map((m) => m.id)).toEqual(["all"]);
    const rev = selectMemories([forAll, forReviewer], q, { load: 0, role: "code-reviewer" }).map((m) => m.id);
    expect(rev).toContain("rev");
    expect(rev).toContain("all");
  });

  it("with no role given, scoped memories are held back (they were addressed to someone)", () => {
    expect(selectMemories([forReviewer], "changing src/store.ts", { load: 0 })).toEqual([]);
  });

  it("expired short-lived memories are not selected; permanent ones never expire", () => {
    const now = 1_000_000;
    const expired: MemoryEntry = { ...base, id: "x", text: "temp note about src/store.ts", persistence: "short", expiresAt: now - 1 };
    const permanent: MemoryEntry = { ...base, id: "p", text: "src/store.ts is the only write path", persistence: "permanent", expiresAt: now - 1 };
    const ids = selectMemories([expired, permanent], "src/store.ts", { load: 0, now }).map((m) => m.id);
    expect(ids).toEqual(["p"]);
  });

  it("isExpired / audienceMatches are honest about the edge cases", () => {
    expect(isExpired({ ...base, id: "a", text: "t" }, 10)).toBe(false); // no TTL → never expires
    expect(isExpired({ ...base, id: "a", text: "t", expiresAt: 10 }, 10)).toBe(true); // inclusive
    expect(audienceMatches({ ...base, id: "a", text: "t", audience: [] }, undefined)).toBe(true); // empty = all
  });
});
