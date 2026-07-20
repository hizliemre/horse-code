import { describe, it, expect } from "vitest";
import { toSlug, uniqueSlug } from "../../src/worktree/slug.js";

describe("toSlug", () => {
  it("kebab-case filesystem-güvenli slug üretir", () => {
    expect(toSlug("Add Auth Endpoint!")).toBe("add-auth-endpoint");
    expect(toSlug("a/b  c")).toBe("a-b-c");
    expect(toSlug("--Foo__Bar--")).toBe("foo-bar");
  });
  it("boş/simge-only girdide fallback döner", () => {
    expect(toSlug("   ")).toBe("job");
    expect(toSlug("!!!")).toBe("job");
  });
});

describe("uniqueSlug", () => {
  it("çakışma yoksa base'i döner", () => {
    expect(uniqueSlug("x", () => false)).toBe("x");
  });
  it("çakışmada -2, -3 ekler", () => {
    const taken = new Set(["x", "x-2"]);
    expect(uniqueSlug("x", (s) => taken.has(s))).toBe("x-3");
  });
});
