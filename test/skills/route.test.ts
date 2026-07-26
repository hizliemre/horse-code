import { describe, it, expect } from "vitest";
import { routeSkills, scoreSkill, isExplicitOnly, isNonImplementing, MATCH_BAR, MAX_ROUTED } from "../../src/skills/route.js";
import { SkillRegistry } from "../../src/skills/registry.js";

/** impeccable's real description, abridged — the text routing has to work against in practice. */
const IMPECCABLE =
  "Use when the user wants to design, redesign, shape, critique, audit, polish, or otherwise improve a " +
  "frontend interface. Covers websites, landing pages, dashboards, product UI, app shells, components, " +
  "forms, settings, onboarding, and empty states. Handles UX review, visual hierarchy, accessibility, " +
  "responsive behavior, theming, typography, spacing, layout, color, motion, and reusable design systems. " +
  "Not for backend-only or non-UI tasks.";

const DEBUG = "Use when debugging a failing test, a crash, or unexpected behaviour — root-cause analysis.";

const registry = (): SkillRegistry => {
  const r = new SkillRegistry();
  r.register({ name: "impeccable", description: IMPECCABLE, content: "IMPECCABLE-BODY" });
  r.register({ name: "systematic-debugging", description: DEBUG, content: "DEBUG-BODY" });
  return r;
};

const route = (task: string, role?: string, already: string[] = []) =>
  routeSkills(task, registry(), already, role ? { role } : {}).map((m) => m.name);

describe("routing a design task to the design skill", () => {
  it.each([
    "Redesign the settings dashboard — the layout feels cluttered and typography is inconsistent",
    "Build the empty state for the invoices table with better visual hierarchy",
    "Make the pricing page bolder, fix the spacing and the color contrast",
  ])("routes %o", (task) => {
    expect(route(task, "designer")).toContain("impeccable");
  });

  /**
   * The role is part of what is being asked. "Add a dark theme toggle to the onboarding screens" is thin on
   * its own; handed to `designer` it is unambiguously interface work.
   */
  it("counts the role as signal", () => {
    const task = "Add a dark theme toggle to the onboarding screens";
    expect(route(task, "designer")).toContain("impeccable");
  });
});

describe("keeping it off work it does not cover", () => {
  it.each([
    "Fix the null pointer crash in the payment retry loop",
    "Add a database index to speed up the orders query",
    "Refactor the auth middleware to use the new token format",
    "Write the API endpoint for creating a subscription",
    "Parse the CSV import and validate the row schema",
    "Add retry with exponential backoff to the webhook sender",
  ])("does not route %o to a design skill", (task) => {
    expect(route(task, "coder")).not.toContain("impeccable");
  });

  /**
   * The skill's own "Not for …" clause is a veto, not a penalty. Without honouring it, the rest of the
   * description would happily match a backend task that merely mentions the word.
   */
  it("obeys the skill's own exclusion clause even when the rest matches", () => {
    const task = "Redesign the backend-only export pipeline: layout of the output, typography of the report";
    expect(route(task, "coder")).not.toContain("impeccable");
  });
});

describe("word matching", () => {
  // A suffix-stripper turns "theming" into "them", which then fails to match "theme". Prefix matching with a
  // dropped trailing -e is what makes these line up.
  it.each([
    ["theme", "theming"],
    ["screens", "screen"],
    ["designer", "design"],
    ["state", "states"],
  ])("treats %o and %o as the same word", (a, b) => {
    expect(scoreSkill(`the ${a} work`, `Use when ${b} matters`).score).toBe(1);
  });

  it("does not collide unrelated short words", () => {
    expect(scoreSkill("format the code", "Use when forms need work").score).toBe(0);
  });

  it("counts a repeated word once, so one term cannot carry a skill in", () => {
    expect(scoreSkill("design design design design", "Use when design matters").score).toBe(1);
  });

  it("an empty task matches nothing", () => {
    expect(scoreSkill("", IMPECCABLE).score).toBe(0);
  });
});

describe("bounds", () => {
  it("never inlines a skill the role already carries", () => {
    const task = "Redesign the dashboard layout and typography";
    expect(route(task, "designer", ["impeccable"])).not.toContain("impeccable");
  });

  it("inlines at most MAX_ROUTED, however many match", () => {
    const r = new SkillRegistry();
    for (let i = 0; i < 6; i++) r.register({ name: `s${i}`, description: IMPECCABLE, content: "b" });
    const got = routeSkills("Redesign the dashboard layout typography spacing color", r);
    expect(got.length).toBeLessThanOrEqual(MAX_ROUTED);
  });

  it("stays below the bar for a passing mention", () => {
    expect(routeSkills("Rename the design_tokens table column", registry())).toEqual([]);
  });

  it("reports WHY it matched, so a routing decision can be explained", () => {
    const m = routeSkills("Redesign the dashboard layout and typography", registry(), [], { role: "designer" });
    expect(m[0].hits.length).toBeGreaterThanOrEqual(MATCH_BAR);
    expect(m[0].hits).toContain("layout");
  });

  it("an empty registry is not an error", () => {
    expect(routeSkills("anything", new SkillRegistry())).toEqual([]);
  });
});

/**
 * Both vetoes below read the skill's OWN description. Matching a skill on its words while ignoring the words
 * that say when not to use it would be reading half the metadata.
 */
describe("a skill that says it must be asked for by name", () => {
  const EXPLICIT = "Pick the right library for a frontend task from a curated list — charts, toasts, " +
    "styling, and more. Only runs when explicitly invoked; it does not trigger on its own.";

  it("is never routed automatically, however well it matches", () => {
    const r = new SkillRegistry();
    r.register({ name: "pick-ui-library", description: EXPLICIT, content: "b" });
    expect(routeSkills("Which library should I use for charts and toasts and styling?", r)).toEqual([]);
  });

  it.each([
    "Only runs when explicitly invoked; it does not trigger on its own.",
    "Use only when explicitly requested by the user.",
    "This does not trigger on its own.",
  ])("recognises the phrasing %o", (d) => { expect(isExplicitOnly(d)).toBe(true); });

  it("does not mistake an ordinary description for one", () => {
    expect(isExplicitOnly("Use when the user wants to design an interface.")).toBe(false);
  });
});

describe("a skill that refuses to write code", () => {
  const PLANNER = "Survey a codebase's animation code and produce a prioritized audit and implementation " +
    "plans. Read-only on source code — it plans improvements, it does not apply them. Use when the user " +
    "asks to improve the animation and motion of an app.";

  const reg = (): SkillRegistry => {
    const r = new SkillRegistry();
    r.register({ name: "improve-animations", description: PLANNER, content: "b" });
    return r;
  };
  const task = "Improve the animation and motion of the app";

  /**
   * Handing a "do not implement" skill to an agent whose whole job this turn is to implement puts it under
   * two contradictory instructions, and that failure shows up as an implementer that produces nothing.
   */
  it("is kept away from an agent that is there to implement", () => {
    expect(routeSkills(task, reg(), [], { implementing: true })).toEqual([]);
  });

  it("still reaches a reviewer or a planner, where it is exactly right", () => {
    expect(routeSkills(task, reg(), [], { implementing: false }).map((m) => m.name)).toEqual(["improve-animations"]);
  });

  it.each([
    "Read-only on source code — it plans improvements.",
    "It proposes motion with exact values, it does not implement it.",
    "It audits; it does not apply them.",
  ])("recognises the phrasing %o", (d) => { expect(isNonImplementing(d)).toBe(true); });

  it("does not mistake an implementing skill for one", () => {
    expect(isNonImplementing("Use when building gesture-driven UI and spring animations.")).toBe(false);
  });
});

describe("ties break on how tight the fit is, not on the alphabet", () => {
  /** A description written for one job. */
  const NARROW = "Reviews animation and motion code against a high craft bar. Approval is earned.";
  /** A description that lists every surface it might ever cover. */
  const BROAD = IMPECCABLE;

  const both = (): SkillRegistry => {
    const r = new SkillRegistry();
    r.register({ name: "zz-narrow", description: NARROW, content: "b" });
    r.register({ name: "aa-broad", description: BROAD, content: "b" });
    return r;
  };

  it("scores the share of a skill's own vocabulary that was hit", () => {
    const narrow = scoreSkill("review the animation motion code", NARROW);
    const broad = scoreSkill("review the animation motion code", BROAD);
    expect(narrow.density).toBeGreaterThan(broad.density);
  });

  /**
   * The bug this fixes: on an animation review three skills tied at three hits, and sorting by name put the
   * one written for reviewing last, where the result cap dropped it. A sprawling description collects
   * incidental hits on almost any interface task; a narrow one only when that is the job.
   */
  it("puts the tighter fit first even when the alphabet says otherwise", () => {
    const got = routeSkills("review the animation motion code", both(), [], { max: 1 });
    expect(got.map((m) => m.name)).toEqual(["zz-narrow"]);
  });

  it("raw hits still win over density — a broad skill that matches a lot is the right answer", () => {
    const got = routeSkills("redesign the dashboard layout typography spacing color onboarding", both());
    expect(got[0].name).toBe("aa-broad");
  });

  it("density is zero when nothing matched", () => {
    expect(scoreSkill("nothing relevant here", NARROW).density).toBe(0);
  });
});
