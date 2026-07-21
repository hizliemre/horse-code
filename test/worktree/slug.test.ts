import { describe, it, expect } from "vitest";
import { toSlug, uniqueSlug } from "../../src/worktree/slug.js";

describe("toSlug", () => {
  it("produces a filesystem-safe kebab-case slug", () => {
    expect(toSlug("Add Auth Endpoint!")).toBe("add-auth-endpoint");
    expect(toSlug("a/b  c")).toBe("a-b-c");
    expect(toSlug("--Foo__Bar--")).toBe("foo-bar");
  });
  it("returns fallback for empty/symbol-only input", () => {
    expect(toSlug("   ")).toBe("job");
    expect(toSlug("!!!")).toBe("job");
  });
});

describe("uniqueSlug", () => {
  it("returns base when there's no conflict", () => {
    expect(uniqueSlug("x", () => false)).toBe("x");
  });
  it("appends -2, -3 on conflict", () => {
    const taken = new Set(["x", "x-2"]);
    expect(uniqueSlug("x", (s) => taken.has(s))).toBe("x-3");
  });
});
