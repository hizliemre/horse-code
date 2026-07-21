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
  it("keeps at most 5 words (meaningful branch-name length), no trailing dash", () => {
    const long = "antigravity hesaplarında hata alıyorum 422 missing google projectid for antigravity account auto discovery via loadcodeassist found no cloud code project";
    const s = toSlug(long);
    expect(s.split("-").length).toBeLessThanOrEqual(5);
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith("-")).toBe(false);
    expect(s).toBe("antigravity-hesaplar-nda-hata-al");
  });

  it("leaves a clean English title (≤5 words) intact", () => {
    expect(toSlug("add-login-page")).toBe("add-login-page");
    expect(toSlug("fix null crash on submit here")).toBe("fix-null-crash-on-submit");
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
