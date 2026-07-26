import { describe, it, expect } from "vitest";
import { applyPreconditions, tuneRoleSkills, SKILL_PRECONDITION } from "../../src/engine/skill-tuner.js";
import { profileProject } from "../../src/engine/project-scan.js";
import type { Provider } from "../../src/core/types.js";

const WITH_TESTS = profileProject(["src/a.ts", "test/a.test.ts", "src/App.tsx"]);
const NO_TESTS = profileProject(["cmd/main.go", "go.mod"]);
const ROLES = ["coder", "senior-coder", "designer", "coach", "judge", "council-risk", "team-spec-clarity"];
const AVAILABLE = ["test-driven-development", "frontend-design", "writing-plans"];

describe("applyPreconditions", () => {
  it("keeps an assignment the project supports", () => {
    const { assignments } = applyPreconditions(
      { coder: ["test-driven-development"] }, ROLES, AVAILABLE, WITH_TESTS,
    );
    expect(assignments.coder).toEqual(["test-driven-development"]);
  });

  // The user's actual complaint: a project that writes no unit tests must not have its coding agents
  // starting to write them because a skill told them to.
  it("withholds a testing skill from a project with no tests, and says why", () => {
    const { assignments, withheld } = applyPreconditions(
      { coder: ["test-driven-development"] }, ROLES, AVAILABLE, NO_TESTS,
    );
    expect(assignments.coder).toEqual([]);
    expect(withheld).toEqual([
      { role: "coder", skill: "test-driven-development", because: SKILL_PRECONDITION["test-driven-development"].because },
    ]);
  });

  it("withholds a design skill from a project with no UI", () => {
    const { assignments } = applyPreconditions({ designer: ["frontend-design"] }, ROLES, AVAILABLE, NO_TESTS);
    expect(assignments.designer).toEqual([]);
  });

  // A skill we did not ship has no precondition we could honestly claim to know — the model judges it, with
  // the same project facts in hand.
  it("does not invent a precondition for a skill it does not know", () => {
    const { assignments } = applyPreconditions({ coder: ["writing-plans"] }, ROLES, AVAILABLE, NO_TESTS);
    expect(assignments.coder).toEqual(["writing-plans"]);
  });

  it("drops a skill that is not installed", () => {
    const { assignments } = applyPreconditions({ coder: ["hallucinated"] }, ROLES, AVAILABLE, WITH_TESTS);
    expect(assignments.coder).toEqual([]);
  });

  it("drops a role that does not exist", () => {
    const { assignments } = applyPreconditions({ nobody: ["writing-plans"] }, ROLES, AVAILABLE, WITH_TESTS);
    expect(assignments.nobody).toBeUndefined();
  });

  it.each(["coach", "judge", "council-risk", "team-spec-clarity"])("never assigns to %s", (role) => {
    const { assignments } = applyPreconditions({ [role]: ["writing-plans"] }, ROLES, AVAILABLE, WITH_TESTS);
    expect(assignments[role]).toBeUndefined();
  });

  // An empty list is not "no opinion" — it is the opt-out that keeps the defaults from coming back.
  it("writes an explicit empty list for an assignable role the model skipped", () => {
    const { assignments } = applyPreconditions({}, ROLES, AVAILABLE, WITH_TESTS);
    expect(assignments.coder).toEqual([]);
    expect(assignments.designer).toEqual([]);
  });

  it("de-duplicates", () => {
    const { assignments } = applyPreconditions(
      { coder: ["writing-plans", "writing-plans"] }, ROLES, AVAILABLE, WITH_TESTS,
    );
    expect(assignments.coder).toEqual(["writing-plans"]);
  });
});

/** A provider that replays one canned completion. */
const canned = (text: string): Provider => ({
  chat: async function* () {
    yield { type: "text-delta" as const, text };
  },
} as unknown as Provider);

const failing = (): Provider => ({
  chat: async function* () {
    yield { type: "error" as const, message: "catalogue unavailable" };
  },
} as unknown as Provider);

const run = (provider: Provider, project = WITH_TESTS) =>
  tuneRoleSkills({
    provider, tuner: "t", project, roles: ROLES, roleProfiles: {},
    skills: AVAILABLE.map((name) => ({ name, description: `desc of ${name}` })),
  });

describe("tuneRoleSkills", () => {
  it("parses a fenced assignment block", async () => {
    const r = await run(canned('Reasoning here.\n```json\n{"assignments":[{"role":"coder","skills":["test-driven-development"]}]}\n```'));
    expect(r.assignments.coder).toEqual(["test-driven-development"]);
    expect(r.reasoning).toBe("Reasoning here.");
  });

  it("enforces the preconditions on what the model returned", async () => {
    const r = await run(
      canned('```json\n{"assignments":[{"role":"coder","skills":["test-driven-development"]}]}\n```'),
      NO_TESTS,
    );
    expect(r.assignments.coder).toEqual([]);
    expect(r.withheld).toHaveLength(1);
  });

  // Leaving the existing assignment alone is the safe failure — it is what the user already had.
  it("changes nothing when the call fails", async () => {
    const r = await failing();
    const out = await run(r);
    expect(out.assignments).toEqual({});
    expect(out.reasoning).toMatch(/failed/);
  });

  it("unparseable output assigns nothing rather than guessing", async () => {
    const r = await run(canned("I could not decide."));
    expect(Object.values(r.assignments).every((v) => v.length === 0)).toBe(true);
  });

  it("says so when nothing is installed", async () => {
    const r = await tuneRoleSkills({
      provider: canned("x"), tuner: "t", project: WITH_TESTS, roles: ROLES, roleProfiles: {}, skills: [],
    });
    expect(r.reasoning).toMatch(/No skills installed/);
  });
});
