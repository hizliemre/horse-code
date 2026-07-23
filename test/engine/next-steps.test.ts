import { describe, it, expect } from "vitest";
import { parseNextSteps, extractListBlock } from "../../src/engine/next-steps.js";

describe("extractListBlock", () => {
  it("extracts an arbitrary tag's list items and strips the block", () => {
    const raw = "Reply.\n<remember>\n- always use pnpm\n- target Node 22\n</remember>";
    const out = extractListBlock(raw, "remember");
    expect(out.text).toBe("Reply.");
    expect(out.items).toEqual(["always use pnpm", "target Node 22"]);
  });

  it("chains: nextsteps then remember, each block stripped independently", () => {
    const raw = "Answer.\n<nextsteps>\n- do X\n</nextsteps>\n<remember>\n- fact A\n</remember>";
    const ns = extractListBlock(raw, "nextsteps");
    const rm = extractListBlock(ns.text, "remember");
    expect(ns.items).toEqual(["do X"]);
    expect(rm.items).toEqual(["fact A"]);
    expect(rm.text).toBe("Answer.");
  });

  it("missing tag → text unchanged, no items", () => {
    expect(extractListBlock("just text", "remember")).toEqual({ text: "just text", items: [] });
  });

  it("extracts a <lesson> block (correction/failure learnings)", () => {
    const raw = "Fixed.\n<lesson>\n- don't mutate props directly; clone first\n</lesson>";
    const out = extractListBlock(raw, "lesson");
    expect(out.text).toBe("Fixed.");
    expect(out.items).toEqual(["don't mutate props directly; clone first"]);
  });
});

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
