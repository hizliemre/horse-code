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
    expect(s).toContain("await runTester(deps, workdir, tools, message, opts.language, law)");
    const up = await src("src/engine/upstream.ts");
    expect(up).toContain("language: r.language,");
  });

  it("reaches the analyst, who asks the user about principles", async () => {
    const s = await src("src/speckit/phases.ts");
    expect(s).toContain("msg + respondIn(language)");
    const up = await src("src/engine/upstream.ts");
    expect(up).toContain("runConstitution(p, r.refinedPrompt, r.language)");
  });

  /** The coach already did this; the wording now comes from one place so the roles cannot drift apart. */
  it("is the same sentence wherever it is used", async () => {
    const s = await src("src/engine/language.ts");
    expect(s).toContain("export function respondIn");
  });
});
