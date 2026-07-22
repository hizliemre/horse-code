import { describe, it, expect } from "vitest";
import { parseNextSteps } from "../../src/engine/next-steps.js";

describe("parseNextSteps", () => {
  it("returns the text unchanged with no steps when there is no block", () => {
    expect(parseNextSteps("just a reply")).toEqual({ text: "just a reply", steps: [] });
  });

  it("strips the <nextsteps> block and parses dash/star/number list items", () => {
    const raw = "Here is the answer.\n\n<nextsteps>\n- Add a test\n* Refactor the parser\n1. Ship it\n</nextsteps>";
    const out = parseNextSteps(raw);
    expect(out.text).toBe("Here is the answer.");
    expect(out.steps).toEqual(["Add a test", "Refactor the parser", "Ship it"]);
  });

  it("handles a block in the middle and ignores empty lines", () => {
    const raw = "Intro <nextsteps>\n- one\n\n- two\n</nextsteps> outro";
    const out = parseNextSteps(raw);
    expect(out.text).toBe("Intro  outro");
    expect(out.steps).toEqual(["one", "two"]);
  });

  it("caps at 6 steps", () => {
    const items = Array.from({ length: 10 }, (_, i) => `- s${i}`).join("\n");
    expect(parseNextSteps(`x<nextsteps>\n${items}\n</nextsteps>`).steps).toHaveLength(6);
  });
});
