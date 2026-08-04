import { describe, it, expect } from "vitest";
import { routeSkills, MAX_ROUTED_CHARS, routingSubject } from "../../src/skills/route.js";
import { SkillRegistry } from "../../src/skills/registry.js";

const reg = (skills: { name: string; description: string; chars: number }[]): SkillRegistry => {
  const r = new SkillRegistry();
  for (const s of skills) r.register({ name: s.name, description: s.description, content: "x".repeat(s.chars) });
  return r;
};

/**
 * A count is not a budget.
 *
 * Three skills were allowed, and a skill is anything from two thousand characters to forty thousand.
 * Measured on a live run: the analyst was handed `image-to-code` (36k) and `imagegen-frontend-mobile` (40k)
 * for a task about HTML rendering and a line-clamp — a 131,265-character prompt in which the one instruction
 * that mattered ("write the spec to this path") was a sentence. It called grep nine times, read three files,
 * and never called `write_file` at all. Twice.
 */
describe("how much skill text a role may be handed", () => {
  const HUGE = [
    { name: "big-a", description: "frontend interface styling web layout", chars: 40_000 },
    { name: "big-b", description: "frontend interface styling web layout", chars: 40_000 },
    { name: "small-c", description: "frontend interface styling web layout", chars: 2_000 },
  ];

  it("stops at a size, not just at a count", () => {
    const picked = routeSkills("frontend interface styling web layout work", reg(HUGE), [], { role: "designer" });
    const total = picked.reduce((n, m) => n + (reg(HUGE).get(m.name)?.content.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(MAX_ROUTED_CHARS);
  });

  it("keeps the best-scoring ones that fit, rather than the first ones tried", () => {
    const skills = [
      { name: "exact-match", description: "line clamp css truncation ellipsis overflow", chars: 3_000 },
      { name: "vaguely-related", description: "css styling frontend web interface layout", chars: 60_000 },
    ];
    const picked = routeSkills("fix the line clamp css truncation ellipsis overflow", reg(skills), [], { role: "designer" });
    expect(picked.map((p) => p.name)).toContain("exact-match");
  });

  it("still routes nothing when nothing matches", () => {
    expect(routeSkills("rename a variable", reg(HUGE), [], { role: "coder" })).toEqual([]);
  });
});

/**
 * Our own plumbing is not a description of the work.
 *
 * A pasted screenshot is written to `~/.horsecode/pastes/paste-N.png` and its path travels in the request as
 * the way to hand the picture over. Feeding that path to the router made "here is a screenshot of the bug"
 * read as "this task is about images", and pulled in two image-GENERATION skills.
 */
describe("what the router is allowed to read", () => {
  it("ignores the path of a pasted screenshot", () => {
    const raw = "Verify from the screenshot /Users/x/.horsecode/pastes/paste-7978-1.png that the description "
      + "is not limited to 3 lines, then fix the line-clamp styling.";
    const subject = routingSubject(raw);
    expect(subject).not.toContain("paste-7978-1.png");
    expect(subject).not.toContain(".horsecode/pastes");
    expect(subject).toContain("line-clamp");        // …while the actual work survives untouched
    expect(subject).toContain("screenshot");        // …including the user's own word for it
  });

  it("leaves an ordinary path alone — a file the work touches IS evidence about the work", () => {
    expect(routingSubject("fix src/products/summary.component.ts")).toContain("src/products/summary.component.ts");
  });
});
