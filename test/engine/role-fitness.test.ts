import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoleFitness, UNFIT_AFTER } from "../../src/engine/role-fitness.js";
import { adjustRoleModels } from "../../src/tui/role-models.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-fit-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/**
 * Role assignment was decided entirely from catalogue metadata — name patterns, a capability band, a spread
 * across subscriptions — and nothing in it had ever seen a model do the work. When a model was benched, the
 * automatic re-assignment reached into that same catalogue and handed the freed roles to whichever model
 * ranked next.
 *
 * Measured on a real board: `antigravity/gpt-oss-120b-medium` and `cc/claude-fable-5` were handed `coder`
 * and `senior-coder` — neither was in those chains, one was in no role at all — and between them answered
 * the implementer in prose 33 times without writing a single file. Editing the config could not fix it: the
 * next re-assignment put them straight back.
 */
describe("RoleFitness", () => {
  it("holds a model unfit for a role only after a pattern, not one bad day", () => {
    const f = new RoleFitness();
    f.record("coder", "a/one", "prose");
    expect(f.unfit("coder", "a/one")).toBe(false);
    f.record("coder", "a/one", "prose");
    expect(f.unfit("coder", "a/one")).toBe(true);
  });

  /**
   * A count with no denominator is not evidence. The first version of this file got that wrong: it would
   * have benched `cc/claude-opus-4-8` from `senior-designer` on two failures without knowing whether they
   * came out of two attempts or two hundred.
   */
  it("does not bench a model that mostly works", () => {
    const f = new RoleFitness();
    for (let i = 0; i < 20; i++) f.ok("senior-designer", "cc/claude-opus-4-8");
    f.record("senior-designer", "cc/claude-opus-4-8", "prose");
    f.record("senior-designer", "cc/claude-opus-4-8", "prose");
    expect(f.unfit("senior-designer", "cc/claude-opus-4-8")).toBe(false); // 2 of 22
  });

  it("benches one that mostly does not", () => {
    const f = new RoleFitness();
    f.ok("coder", "b/two");
    for (let i = 0; i < 3; i++) f.record("coder", "b/two", "prose");
    expect(f.unfit("coder", "b/two")).toBe(true); // 3 of 4
  });

  /** Success moves the model back out of the record's way, without erasing what happened. */
  it("lets a model earn its way back", () => {
    const f = new RoleFitness();
    f.record("coder", "c/three", "prose");
    f.record("coder", "c/three", "prose");
    expect(f.unfit("coder", "c/three")).toBe(true);
    for (let i = 0; i < 3; i++) f.ok("coder", "c/three");
    expect(f.unfit("coder", "c/three")).toBe(false); // 2 of 5
  });

  /** The whole reason the record is per-role: a model that cannot implement may review perfectly well. */
  it("keeps a model available to every OTHER role", () => {
    const f = new RoleFitness();
    for (let i = 0; i < UNFIT_AFTER; i++) f.record("coder", "a/one", "prose");
    f.ok("code-reviewer", "a/one");
    expect(f.unfit("coder", "a/one")).toBe(true);
    expect(f.unfit("code-reviewer", "a/one")).toBe(false);
    expect(f.unfit("judge", "a/one")).toBe(false);
  });

  /** A role with no model stops the run; a role with a bad one wastes an attempt and rotates. */
  it("never strands a role with an empty chain", () => {
    const f = new RoleFitness();
    for (let i = 0; i < UNFIT_AFTER; i++) { f.record("coder", "a/one", "x"); f.record("coder", "b/two", "x"); }
    expect(f.fitFor("coder", ["a/one", "b/two"])).toEqual(["a/one", "b/two"]);
  });

  it("drops only the unfit ones when something fit remains", () => {
    const f = new RoleFitness();
    for (let i = 0; i < UNFIT_AFTER; i++) f.record("coder", "a/one", "x");
    expect(f.fitFor("coder", ["a/one", "b/two"])).toEqual(["b/two"]);
  });

  it("survives the session that recorded it", async () => {
    const path = join(dir, "fit.json");
    const a = new RoleFitness(path);
    for (let i = 0; i < UNFIT_AFTER; i++) a.record("coder", "a/one", "answered in prose");
    expect(a.list()[0].attempts).toBe(UNFIT_AFTER); // the denominator survives too
    expect(new RoleFitness(path).unfit("coder", "a/one")).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))[0].reason).toContain("prose");
  });

  /** A cache, not a source of truth: a corrupt file costs a repeated mistake, not a stopped run. */
  it("starts empty rather than throwing on an unreadable file", () => {
    expect(new RoleFitness(join(dir, "nope", "deep", "missing.json")).list()).toEqual([]);
  });

  it("forgets on request — a model broken in March may be fine in June", () => {
    const f = new RoleFitness();
    for (let i = 0; i < UNFIT_AFTER; i++) f.record("coder", "a/one", "x");
    f.clear("coder", "a/one");
    expect(f.unfit("coder", "a/one")).toBe(false);
  });
});

describe("adjustRoleModels learns from the record", () => {
  const MODELS = ["cc/claude-opus-4-8", "cx/gpt-5.6-terra", "antigravity/gpt-oss-120b-medium", "cc/claude-sonnet-4-6"];

  it("does not hand a role a model that role has proven it cannot use", () => {
    const unfit = (role: string, m: string) => role === "coder" && m === "antigravity/gpt-oss-120b-medium";
    const picked = adjustRoleModels(["coder"], MODELS, unfit);
    expect(picked[0].models).not.toContain("antigravity/gpt-oss-120b-medium");
  });

  /** A bad model is no better as the second choice than the first — it just fails one attempt later. */
  it("filters the fallbacks too, not only the primary", () => {
    const unfit = (_r: string, m: string) => m === "cc/claude-sonnet-4-6";
    for (const { models } of adjustRoleModels(["coder", "designer"], MODELS, unfit)) {
      expect(models).not.toContain("cc/claude-sonnet-4-6");
    }
  });

  it("still assigns the role when everything available is unfit", () => {
    const picked = adjustRoleModels(["coder"], MODELS, () => true);
    expect(picked[0].models.length).toBeGreaterThan(0);
  });

  it("behaves exactly as before when nothing has been recorded", () => {
    expect(adjustRoleModels(["coder", "judge"], MODELS)).toEqual(adjustRoleModels(["coder", "judge"], MODELS, () => false));
  });
});
