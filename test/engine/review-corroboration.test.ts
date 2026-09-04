import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodeReview, buildTeamRegistry, CORROBORATION_FLOOR, corroboratedCriticals } from "../../src/engine/review.js";
import type { ReviewDeps } from "../../src/engine/review.js";
import type { ReviewerConfig } from "../../src/config/config.js";
import type { Provider } from "../../src/core/types.js";
import { rdeps } from "./review.test.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-corr-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/**
 * A team big enough for a second opinion to be possible — see CORROBORATION_FLOOR.
 *
 * The perspectives are deliberately nonsense tokens. Real words ("correctness", "security") appear in the
 * COUNCIL prompt too and in each other's, so a mock keyed on them answers for the wrong agent — which is
 * exactly how the first version of this test made a solo critical look corroborated.
 */
const big: ReviewerConfig[] = ["ZQA", "ZQB", "ZQC", "ZQD", "ZQE", "ZQF"]
  .map((t, i) => ({ name: `code-lens-${i}`, perspective: t, models: ["m"] }));

/** Each lens answers by its own unique token. The council is answered first, so it can never be mistaken. */
function teamProvider(byToken: Record<string, string>, asked?: string[]): Provider {
  return {
    async *chat(req) {
      const sys = typeof req.messages[0]?.content === "string" ? req.messages[0].content : "";
      const emit = (args: string) => ({ type: "tool-call" as const, toolCall: { id: "s", name: "submit", arguments: args } });
      if (/review COUNCIL|COUNCIL/.test(sys)) {
        yield emit('{"vote":"revise","rationale":"r"}');
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      const key = Object.keys(byToken).find((k) => sys.includes(k));
      if (key && asked) asked.push(key);
      yield emit(key ? byToken[key] : '{"findings":[],"recommendation":"approve"}');
      yield { type: "done", finishReason: "tool_calls" };
    },
  };
}

const deps = (p: Provider): ReviewDeps => {
  const d = rdeps(p);
  return { ...d, teams: { ...d.teams, code: big }, teamRegistries: { ...d.teamRegistries, code: buildTeamRegistry("code", big) } };
};

const crit = (note: string): string => `{"findings":[{"severity":"critical","note":"${note}"}],"recommendation":"revise"}`;

/**
 * Fifteen independent vetoes make a clean round improbable. From one board's attempt counts — 1, 2, 3, 4 and
 * 6 — each lens raises a critical about 7.5% of the time, which at fifteen lenses is a one-in-three chance of
 * passing, and the cost is attempts TIMES team size. The same board's 11 criticals were 6 distinct defects,
 * and 3 of those were named by two or more lenses: corroboration keeps what several lenses can see.
 */
describe("the rule itself", () => {
  const a = (name: string, ...notes: string[]) =>
    ({ name, findings: notes.map((note) => ({ severity: "critical", note })) });
  const six = (...xs: ReturnType<typeof a>[]) =>
    [...xs, ...Array.from({ length: Math.max(0, 6 - xs.length) }, (_, i) => a(`filler-${i}`))];

  it("counts nothing when one lens is alone with its finding", () => {
    expect(corroboratedCriticals(six(a("code-correctness", "UpdateCompanyDetails commits before it sends")))).toBe(0);
  });

  it("counts a subject two lenses both name", () => {
    expect(corroboratedCriticals(six(
      a("code-correctness", "UpdateCompanyDetails commits before it sends"),
      a("code-concurrency", "UpdateCompanyDetails saves the tax number before delivery"),
    ))).toBe(1);
  });

  it("does not merge two lenses shouting about different things", () => {
    expect(corroboratedCriticals(six(
      a("code-correctness", "UpdateCompanyDetails commits before it sends"),
      a("code-simplicity", "QueuePendingSupplierTarget has no external caller"),
    ))).toBe(0);
  });

  /** Below the floor there is no second opinion to be had, so every critical counts, as it always did. */
  it("keeps the single-veto rule for a team too small to corroborate", () => {
    expect(corroboratedCriticals([a("security", "unchecked input"), a("arch")])).toBe(1);
  });
});

describe("a critical needs a second lens to send a task back", () => {
  it("defers a critical only one lens raised", async () => {
    const v = await runCodeReview(deps(teamProvider({ ZQA: crit("UpdateCompanyDetails commits before it sends") })), dir, "t");
    expect(v.verdict).toBe("pass");
    // Deferred, not dropped — the revision pass adjudicates it on the merged result.
    expect(v.deferred?.join(" ")).toContain("UpdateCompanyDetails");
  });

  it("blocks when a second lens names the same subject", async () => {
    const v = await runCodeReview(deps(teamProvider({
      ZQA: crit("UpdateCompanyDetails commits before it sends"),
      ZQD: crit("UpdateCompanyDetails saves the tax number before delivery"),
    })), dir, "t");
    expect(v.verdict).toBe("fail");
  });

  /** Two lenses shouting about unrelated things is not corroboration — it is two solo findings. */
  it("does not treat two different subjects as corroboration", async () => {
    const v = await runCodeReview(deps(teamProvider({
      ZQA: crit("UpdateCompanyDetails commits before it sends"),
      ZQE: crit("QueuePendingSupplierTarget has no external caller"),
    })), dir, "t");
    expect(v.verdict).toBe("pass");
    expect(v.deferred?.length).toBe(2);
  });

  /**
   * A small team has no second opinion to give. Asked for one, a real critical could never block and the
   * gate would be off entirely — so below the floor the original rule stands.
   */
  it("keeps the single-veto rule for a team too small to corroborate", async () => {
    const d = rdeps(teamProvider({ "security vulnerabilities": crit("unchecked input") }));
    expect(d.teams.code.length).toBeLessThan(CORROBORATION_FLOOR);
    const v = await runCodeReview(d, dir, "t");
    expect(v.verdict).toBe("fail");
  });
});

/**
 * A returning task re-ran the whole team, so a lens with nothing to say was asked again — fifteen calls to
 * learn what fourteen had already answered.
 */
describe("carrying approvals into the next attempt", () => {
  it("reports which lenses approved, so the card can remember them", async () => {
    const v = await runCodeReview(deps(teamProvider({})), dir, "t");
    expect(v.approvedLenses).toEqual(big.map((c) => c.name));
  });

  it("asks only the lenses that objected", async () => {
    const asked: string[] = [];
    const p = teamProvider({ ZQA: crit("still wrong") }, asked);
    const cleared = big.filter((c) => c.name !== "code-lens-0").map((c) => c.name);
    await runCodeReview(deps(p), dir, "t", undefined, () => {}, 1, cleared);
    // Only the objector's own perspective was reached; nobody else was asked.
    expect(asked).toEqual(["ZQA"]);
  });

  it("keeps a lens's earlier approval in the list it hands back", async () => {
    const cleared = ["code-lens-1", "code-lens-2"];
    const v = await runCodeReview(deps(teamProvider({})), dir, "t", undefined, () => {}, 1, cleared);
    for (const name of cleared) expect(v.approvedLenses).toContain(name);
  });

  /** Nothing left to ask is a pass, not an empty review that trips the coverage floor. */
  it("passes when every lens has already approved", async () => {
    const v = await runCodeReview(deps(teamProvider({})), dir, "t", undefined, () => {}, 2, big.map((c) => c.name));
    expect(v.verdict).toBe("pass");
  });
});
