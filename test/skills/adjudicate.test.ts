import { describe, it, expect } from "vitest";
import { adjudicateSkills } from "../../src/skills/adjudicate.js";
import { partitionByConfidence, MATCH_BAR, CONFIDENT_MARGIN } from "../../src/skills/route.js";
import type { SkillMatch } from "../../src/skills/route.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import type { Provider } from "../../src/core/types.js";

const m = (name: string, score: number): SkillMatch => ({ name, score, hits: [], density: 0.1 });

const registry = (): SkillRegistry => {
  const r = new SkillRegistry();
  r.register({ name: "impeccable", description: "design interfaces", content: "b" });
  r.register({ name: "apple-design", description: "gesture-driven UI", content: "b" });
  return r;
};

const canned = (text: string): Provider => ({
  chat: async function* () { yield { type: "text-delta" as const, text }; },
} as unknown as Provider);

const failing = (): Provider => ({
  chat: async function* () { yield { type: "error" as const, message: "boom" }; },
} as unknown as Provider);

const run = (matches: SkillMatch[], provider: Provider) =>
  adjudicateSkills({ provider, model: "m", task: "implement store crud methods", matches, registry: registry() });

describe("partitionByConfidence", () => {
  /**
   * Measured on a real project: every false positive sat exactly at the bar, and every match well clear of
   * it was right. That is the line worth spending a call on.
   */
  it("treats a match well clear of the bar as settled", () => {
    const { confident, borderline } = partitionByConfidence([m("a", MATCH_BAR + CONFIDENT_MARGIN)]);
    expect(confident.map((x) => x.name)).toEqual(["a"]);
    expect(borderline).toEqual([]);
  });

  it("treats a match at the bar as needing a second opinion", () => {
    const { confident, borderline } = partitionByConfidence([m("a", MATCH_BAR)]);
    expect(confident).toEqual([]);
    expect(borderline.map((x) => x.name)).toEqual(["a"]);
  });
});

describe("adjudicateSkills", () => {
  // Most tasks must cost nothing: the spend belongs where the noise is, not on answers already known.
  it("does not call the model when nothing is borderline", async () => {
    let calls = 0;
    const counting = { chat: async function* () { calls++; yield { type: "text-delta" as const, text: "x" }; } } as unknown as Provider;
    const r = await run([m("impeccable", MATCH_BAR + CONFIDENT_MARGIN)], counting);
    expect(calls).toBe(0);
    expect(r.asked).toBe(false);
    expect(r.keep.map((x) => x.name)).toEqual(["impeccable"]);
  });

  it("does not call the model when there are no matches at all", async () => {
    let calls = 0;
    const counting = { chat: async function* () { calls++; yield { type: "text-delta" as const, text: "x" }; } } as unknown as Provider;
    await adjudicateSkills({ provider: counting, model: "m", task: "t", matches: [], registry: registry() });
    expect(calls).toBe(0);
  });

  it("drops a borderline match the model rejects", async () => {
    const r = await run([m("impeccable", MATCH_BAR)], canned('Data layer.\n```json\n{"keep":[]}\n```'));
    expect(r.keep).toEqual([]);
    expect(r.asked).toBe(true);
    expect(r.reasoning).toContain("Data layer");
  });

  it("keeps a borderline match the model accepts", async () => {
    const r = await run([m("impeccable", MATCH_BAR)], canned('```json\n{"keep":["impeccable"]}\n```'));
    expect(r.keep.map((x) => x.name)).toEqual(["impeccable"]);
  });

  it("judges each borderline match separately", async () => {
    const r = await run(
      [m("impeccable", MATCH_BAR), m("apple-design", MATCH_BAR)],
      canned('```json\n{"keep":["apple-design"]}\n```'),
    );
    expect(r.keep.map((x) => x.name)).toEqual(["apple-design"]);
  });

  it("never drops a confident match, whatever the verdict says", async () => {
    const r = await run(
      [m("impeccable", MATCH_BAR + CONFIDENT_MARGIN), m("apple-design", MATCH_BAR)],
      canned('```json\n{"keep":[]}\n```'),
    );
    expect(r.keep.map((x) => x.name)).toEqual(["impeccable"]);
  });

  // The fallback is the behaviour that shipped before adjudication existed, not silence.
  it("keeps the deterministic answer when the call fails", async () => {
    const r = await run([m("impeccable", MATCH_BAR)], failing());
    expect(r.keep.map((x) => x.name)).toEqual(["impeccable"]);
    expect(r.asked).toBe(false);
  });

  it("keeps the deterministic answer when the verdict is unparseable", async () => {
    const r = await run([m("impeccable", MATCH_BAR)], canned("I am not sure."));
    expect(r.keep.map((x) => x.name)).toEqual(["impeccable"]);
  });

  it("ignores a skill name the model invented", async () => {
    const r = await run([m("impeccable", MATCH_BAR)], canned('```json\n{"keep":["not-a-skill"]}\n```'));
    expect(r.keep).toEqual([]);
  });

  it("tells the model that rejecting everything is a normal answer", async () => {
    let seen = "";
    const spy = {
      chat: async function* (req: { messages: { content: string }[] }) {
        seen = req.messages.map((x) => x.content).join("\n");
        yield { type: "text-delta" as const, text: '```json\n{"keep":[]}\n```' };
      },
    } as unknown as Provider;
    await run([m("impeccable", MATCH_BAR)], spy);
    expect(seen).toMatch(/Rejecting all of them is a normal and frequent answer/);
    expect(seen).toMatch(/not by whether they share words/);
  });
});
