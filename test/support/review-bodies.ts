import { buildTeamRegistry, buildCouncilRegistry, type ReviewStage } from "../../src/engine/review.js";
import type { ReviewerConfig } from "../../src/config/config.js";
import type { RoleRegistry } from "../../src/agent/roles.js";

/**
 * Minimal review bodies for tests: one finder lens per stage + one council decider, all on model "m".
 * Tests that care about the review itself pass their own sets; everything else just needs the shape.
 */
export function reviewBodies(over: Partial<Record<ReviewStage, ReviewerConfig[]>> & { council?: ReviewerConfig[] } = {}): {
  teams: Record<ReviewStage, ReviewerConfig[]>;
  teamRegistries: Record<ReviewStage, RoleRegistry>;
  council: ReviewerConfig[];
  councilRegistry: RoleRegistry;
} {
  const teams: Record<ReviewStage, ReviewerConfig[]> = {
    spec: over.spec ?? [{ name: "spec-completeness", perspective: "coverage of the requested scope", models: ["m"] }],
    plan: over.plan ?? [{ name: "plan-architecture", perspective: "layering and boundaries", models: ["m"] }],
    code: over.code ?? [{ name: "code-correctness", perspective: "logical correctness", models: ["m"] }],
  };
  const council = over.council ?? [{ name: "risk-judge", perspective: "blast radius of shipping as-is", models: ["m"] }];
  return {
    teams,
    teamRegistries: {
      spec: buildTeamRegistry("spec", teams.spec),
      plan: buildTeamRegistry("plan", teams.plan),
      code: buildTeamRegistry("code", teams.code),
    },
    council,
    councilRegistry: buildCouncilRegistry(council),
  };
}

/**
 * Scripted provider turns for the CODE-stage review (used by sequential MockProvider tests). With the single
 * lens + single decider from `reviewBodies()`: an approve needs one team turn; a revise needs the team turn
 * plus the council vote it triggers.
 */
export function codeReviewPass(): { type: "tool-call"; toolCall: { id: string; name: string; arguments: string } }[][] {
  return [submitTurn('{"findings":[],"recommendation":"approve"}')];
}
export function codeReviewFail(note = "needs work"): ReturnType<typeof codeReviewPass> {
  return [
    submitTurn(JSON.stringify({ findings: [{ severity: "critical", note }], recommendation: "revise" })),
    submitTurn(JSON.stringify({ vote: "revise", rationale: note })),
  ];
}
function submitTurn(args: string): { type: "tool-call"; toolCall: { id: string; name: string; arguments: string } }[] {
  return [
    { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: args } },
    { type: "done", finishReason: "tool_calls" } as never,
  ];
}
