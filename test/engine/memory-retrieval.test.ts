import { describe, it, expect } from "vitest";
import {
  deriveAnchors, deriveTags, scoreMemory, hintBudget, selectMemories, renderMemoryHints,
  supersedes, memoryReferenced,
  type MemoryEntry,
} from "../../src/engine/memory-retrieval.js";

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

describe("renderMemoryHints", () => {
  it("renders a bulleted hint block", () => {
    const out = renderMemoryHints([entry("a", "use pnpm"), entry("b", "node 22")]);
    expect(out).toContain("Relevant notes from earlier sessions");
    expect(out).toContain("- use pnpm");
    expect(out).toContain("- node 22");
  });
});
