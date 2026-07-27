import { describe, it, expect } from "vitest";
import { toSlug, uniqueSlug } from "../../src/worktree/slug.js";

describe("toSlug", () => {
  it("produces a filesystem-safe kebab-case slug", () => {
    expect(toSlug("Add Auth Endpoint!")).toBe("auth-endpoint");
    // Letters chosen to avoid an article: this asserts the SEPARATOR rule, and a leading "a" would
    // now be stripped as one.
    expect(toSlug("x/y  z")).toBe("x-y-z");
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
    expect(toSlug("login-page")).toBe("login-page");
    // The verb goes and the cap then reaches a word further into the description — which is the point:
    // "fix" was occupying one of five slots to say what the tool was always going to do.
    expect(toSlug("fix null crash on submit here")).toBe("null-crash-on-submit-here");
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

/**
 * A worktree names the THING being worked on, not the doing of it.
 *
 * Every task description opens with a verb, so every name inherited one — `build-luxury-todo-app` — and the
 * verb carried no information: of course it is being built, that is what the tool does. Worse, it crowded
 * out a word that would have identified the work, since the name is capped at five.
 */
describe("the name is the subject, not the action", () => {
  it.each([
    ["build a luxury todo app", "luxury-todo-app"],
    ["build-luxury-todo-app", "luxury-todo-app"],
    ["add a login page", "login-page"],
    ["implement store CRUD methods", "store-crud-methods"],
    ["Setup testing infrastructure", "testing-infrastructure"],
    ["create the export pipeline", "export-pipeline"],
  ])("%o becomes %o", (input, expected) => {
    expect(toSlug(input)).toBe(expected);
  });

  /** A bugfix names what is broken, which is still a subject. */
  it("keeps the subject of a fix", () => {
    expect(toSlug("fix the null crash on retry")).toBe("null-crash-on-retry");
  });

  /**
   * Only the articles are dropped with the verb. "new" reads as filler in a sentence but is the
   * distinguishing word in a name — `new-empty` and `old-empty` are two different worktrees.
   */
  it("keeps a qualifier that distinguishes one name from another", () => {
    expect(toSlug("create the new export pipeline")).toBe("new-export-pipeline");
    expect(toSlug("new-empty")).toBe("new-empty");
  });

  it("leaves a name that never had a verb alone", () => {
    expect(toSlug("luxury todo app")).toBe("luxury-todo-app");
  });

  /** An empty name is worse than a slightly wrong one. */
  it("keeps a name that is nothing but a verb", () => {
    expect(toSlug("refactor")).toBe("refactor");
    expect(toSlug("build")).toBe("build");
  });

  // Only the front: a verb in the middle is part of what the thing is called.
  it("does not strip a verb from the middle", () => {
    expect(toSlug("the build pipeline")).toBe("build-pipeline");
  });

  it("frees a word for the cap, which is what makes long names read", () => {
    // Five words either way — but the five are now the ones that identify the work.
    expect(toSlug("build a luxury offline-first todo app")).toBe("luxury-offline-first-todo-app");
  });
});
