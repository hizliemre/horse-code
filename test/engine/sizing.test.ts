import { describe, it, expect } from "vitest";
import { RequestSizeSchema, describeSizeDoubt } from "../../src/engine/triage.js";

/**
 * A run measured end to end: 94 minutes, 507 model calls, 48.4 million prompt characters — for what the user
 * described as a simple UI fix. The whole of it was bought by one decision at the 114th second, where the
 * sizing answered "not small" and the pipeline started.
 *
 * The old instruction said "when in doubt, say it is not small", on the reasoning that a task too big for the
 * small path gets written and reviewed as though it were understood. That reasoning was right about the
 * danger and wrong about the cost: a mistake on the SMALL path is cheap — the change is reviewed, checked
 * against acceptance criteria, and happens in front of a developer who is watching — while a mistake on the
 * large path is an hour and a half.
 *
 * So doubt no longer buys anything. It asks the person who is already sitting there.
 */
describe("what happens when the size is not obvious", () => {
  it("has a verdict for doubt, distinct from both answers", () => {
    for (const verdict of ["small", "large", "unsure"]) {
      expect(RequestSizeSchema.safeParse({ verdict, reason: "r", acceptance: ["a"], files: [] }).success).toBe(true);
    }
    expect(RequestSizeSchema.safeParse({ verdict: "maybe", reason: "r" }).success).toBe(false);
  });

  it("asks in the terms of what each answer costs, not in the terms of the code", () => {
    const q = describeSizeDoubt("centre the icon", "it might touch the shared layout component");
    expect(q).toContain("centre the icon");
    expect(q).toContain("shared layout component");
    expect(q).toMatch(/spec|plan/i);          // what the big path buys
    expect(q).toMatch(/review/i);             // …and what the small one still keeps
  });
});
