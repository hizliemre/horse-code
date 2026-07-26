import { describe, it, expect } from "vitest";
import { extractChoices, extractChoicesFrom, looksLikeChoices } from "../../src/engine/normalize-question.js";

/**
 * An agent that embeds its options in a markdown table has already done the structuring work.
 *
 * Asking a model to redo it added a call, a delay and a failure mode to something that can simply be read —
 * and that failure was silent: when the normalizer threw or returned nothing, the question fell through as
 * free text and nobody could tell whether it had even run. A real question with a clean A/B/C/D table
 * arrived as a wall of prose with a text box under it.
 */
describe("extractChoices — a question that lists its own options", () => {
  const TABLE = [
    "Which scale bound should v1 target?",
    "",
    "| Option | Açıklama |",
    "|--------|----------|",
    "| A | Mütevazı: 200 task per project, 20 projects, 30 tags. |",
    "| B | Power-user (önerilen): 1.000 task, 50 project, 100 tag. |",
    "| C | İddialı: 5.000 task, 200 project. Needs virtualization. |",
    "| D | Explicitly unbounded in v1. |",
  ].join("\n");

  it("reads a markdown table", () => {
    const got = extractChoices(TABLE);
    expect(got.map((c) => c.label)).toEqual(["A", "B", "C", "D"]);
    expect(got[1].description).toContain("Power-user");
  });

  /** The header names the columns; it is not a choice. */
  it("drops the header row", () => {
    expect(extractChoices(TABLE).some((c) => /^option$/i.test(c.label))).toBe(false);
  });

  it("drops the separator row", () => {
    expect(extractChoices(TABLE).some((c) => c.label.includes("---"))).toBe(false);
  });

  it("joins extra columns into the description", () => {
    const t = "| Option | What | Cost |\n|---|---|---|\n| A | fast | cheap |\n| B | slow | dear |";
    expect(extractChoices(t)[0].description).toBe("fast — cheap");
  });

  it("reads a lettered list", () => {
    const got = extractChoices("Pick one:\nA) Keep it simple\nB) Add the abstraction\nC) Defer the decision");
    expect(got).toHaveLength(3);
    expect(got[0].label).toBe("A — Keep it simple");
  });

  it.each([
    ["prose with no choices at all", "What should the retry budget be?"],
    ["a single table row", "| Option | Açıklama |\n|---|---|\n| A | only one |"],
    ["a single lettered item", "A) the only one"],
  ])("finds nothing in %s", (_why, text) => {
    expect(extractChoices(text)).toEqual([]);
  });

  it("an empty question is not an error", () => {
    expect(extractChoices("")).toEqual([]);
  });
});

describe("looksLikeChoices still gates it", () => {
  it("recognises the table that reaches extractChoices", () => {
    expect(looksLikeChoices("| A | x |\n| B | y |")).toBe(true);
  });

  it("does not fire on a plain question", () => {
    expect(looksLikeChoices("What should the retry budget be?")).toBe(false);
  });
});

/** Printing the table AND the list makes the reader check whether the two differ. */
describe("the consumed list is removed from the question", () => {
  it("strips a table, header and separator alike", () => {
    const { question, choices } = extractChoicesFrom(
      "Which bound?\n\n| Option | Why |\n|---|---|\n| A | small |\n| B | large |");
    expect(question).toBe("Which bound?");
    expect(choices).toHaveLength(2);
  });

  it("strips a lettered list", () => {
    const { question } = extractChoicesFrom("Pick one:\nA) keep it simple\nB) add the layer");
    expect(question).toBe("Pick one:");
  });

  it("keeps the prose around it", () => {
    const { question } = extractChoicesFrom(
      "Which bound?\n\n**Recommended:** B, because it fits one write.\n\n| A | small |\n| B | large |");
    expect(question).toContain("Recommended:");
    expect(question).not.toContain("| A |");
  });

  it("leaves a question with nothing to extract untouched", () => {
    const q = "What should the retry budget be?";
    expect(extractChoicesFrom(q).question).toBe(q);
  });
});
