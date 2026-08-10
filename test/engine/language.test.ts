import { describe, it, expect } from "vitest";
import { respondIn } from "../../src/engine/language.js";

const src = async (f: string): Promise<string> =>
  (await import("node:fs/promises")).readFile(f, "utf8");

/**
 * A session driven entirely in Turkish was answered in English for thirty-six minutes.
 *
 * The refiner detects the user's language and every checkpoint records it — but only the chat coach and the
 * two review gates ever read it. The tester was never told, so it reported "Required environment is not
 * running yet. Observed: … Please start: …" and asked its questions in English. The user finally typed the
 * rule out loud, and even THAT reached the agent as English: the refiner rewrites every request into English
 * before anyone sees it, which is exactly why a role has to be told separately.
 */
describe("telling a role which language to answer in", () => {
  it("says it plainly, and only about what the user reads", () => {
    const said = respondIn("Turkish");
    expect(said).toContain("Respond to the user in Turkish");
    expect(said).toMatch(/every question you ask/i);
    expect(said).toMatch(/Code, identifiers, logs and commit messages/i);
  });

  /** English is the pipeline's own language: saying "respond in English" is noise in every prompt. */
  it("says nothing when there is nothing to say", () => {
    expect(respondIn()).toBe("");
    expect(respondIn("English")).toBe("");
    expect(respondIn("english")).toBe("");
  });

  it("reaches the tester, who asks the questions and writes the report", async () => {
    const s = await src("src/engine/verify.ts");
    expect(s).toContain("respondIn(language)");
    // The language reaches every dispatch — asserted per call rather than by matching one exact argument
    // list, which broke the first time an argument was added after it.
    const calls = s.match(/runTester\(deps[^;]*\);/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c, c).toContain("opts.language");
    const up = await src("src/engine/upstream.ts");
    expect(up).toContain("language: r.language,");
  });

  /**
   * The analyst asking about principles was the FIRST phase to get this, and for a while the only one — see
   * "which phases know what the user speaks" below. It is now applied in `runRole`, which every phase goes
   * through, so this asserts the reach rather than the one call site it used to have.
   */
  it("reaches the analyst, who asks the user about principles", async () => {
    const s = await src("src/speckit/phases.ts");
    expect(s).toContain("respondIn(p.language)");
    const up = await src("src/engine/upstream.ts");
    expect(up).toContain("language: r.language");
  });

  /** The coach already did this; the wording now comes from one place so the roles cannot drift apart. */
  it("is the same sentence wherever it is used", async () => {
    const s = await src("src/engine/language.ts");
    expect(s).toContain("export function respondIn");
  });
});

/**
 * Every spec-kit phase talks to the user, and only one of them was told what the user speaks.
 *
 * Reported live from a run driven entirely in Turkish: the spec revision narrated itself in English — "I'll
 * start by reading the current spec and the referenced source files to verify the contradictions before
 * revising." Each of these phases narrates as it works and two of them ask outright, and all of it lands in
 * the chat. `runConstitution` had the language because it was the one someone was looking at when the
 * mechanism was written; a parameter that must be remembered at six call sites is one that gets forgotten at
 * five of them.
 */
describe("which phases know what the user speaks", () => {
  const src = async (f: string): Promise<string> => (await import("node:fs/promises")).readFile(f, "utf8");

  it("applies it once, where every phase goes through", async () => {
    const s = await src("src/speckit/phases.ts");
    const at = s.indexOf("async function runRole");
    const fn = s.slice(at, s.indexOf("\n}\n", at));
    expect(fn).toContain("respondIn(p.language)");
  });

  /** …carried on the deps, so a new phase cannot be added without it. */
  it("carries it on the deps rather than per call", async () => {
    const s = await src("src/speckit/phases.ts");
    expect(s).toContain("language?: string;");
    // The per-phase parameter is gone — two ways to supply it is how one of them goes stale.
    expect(s).not.toContain("request?: string, language?: string");
    expect(s).not.toContain("msg + respondIn(language)");
  });

  it("is filled from the refiner's detection at both entry points", async () => {
    const up = await src("src/engine/upstream.ts");
    const built = up.match(/const p: PhaseDeps = \{[^}]*\}/g) ?? [];
    expect(built.length).toBeGreaterThan(0);
    for (const b of built) expect(b, b).toContain("language: r.language");
  });
});
