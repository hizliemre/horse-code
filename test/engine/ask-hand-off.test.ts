import { describe, it, expect } from "vitest";
import { buildAskUserTool } from "../../src/engine/writer-registry.js";
import { makeAskUser } from "../../src/terminal.js";
import { parsePending } from "../../src/tui/components.js";
import type { AskOpts } from "../../src/engine/review.js";

const ctx = (said = ""): Parameters<ReturnType<typeof buildAskUserTool>["run"]>[1] =>
  ({ cwd: "/tmp", signal: new AbortController().signal, said }) as never;

/** Captures what reached the UI layer, so a test can assert on the prompt AND the options. */
function recorder(): { asked: { prompt: string; opts?: AskOpts }[]; read: (p: string, o?: AskOpts) => Promise<string> } {
  const asked: { prompt: string; opts?: AskOpts }[] = [];
  return { asked, read: async (prompt, opts) => { asked.push({ prompt, opts }); return "ok"; } };
}

/**
 * A request to go and do something is not a question, and it has to carry what it asks for.
 *
 * Reported live during a manual test session. The tester wrote its scenario into the test-plan document,
 * then asked "share your Network/UI observation according to the 5 items above" — the five items were in a
 * file on a branch, and the developer was at a terminal. The answer was "the steps aren't in the chat?",
 * twice. The same box also said "? Question", for something that was not a question at all: the user was
 * not being consulted, they were being handed the next step.
 */
describe("handing the next step to the user", () => {
  it("refuses a question that points at something the user cannot see", async () => {
    const tool = buildAskUserTool(async () => "unreachable");
    const r = await tool.run({ question: "Report your observation per the 5 items above." }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("steps");
  });

  it("catches the same reference in the user's own language", async () => {
    const tool = buildAskUserTool(async () => "unreachable");
    const r = await tool.run({ question: "Gözleminizi yukarıdaki 5 maddeyle paylaşın." }, ctx());
    expect(r.isError).toBe(true);
  });
});

/**
 * The same defect, pointing by NAME instead of by direction — which is the form it actually takes.
 *
 * Measured live, twice on one turn. The analyst asked, verbatim:
 *
 *   "Lütfen Q1, Q2 ve Q3 için seçeneklerinizi belirtin. Örnek: Q1: B, Q2: A, Q3: C."
 *
 * Q1, Q2 and Q3 appeared nowhere — 1,483 output tokens with `hc.text_chars: 0`, so the questions and their
 * options existed only inside the model's reasoning. The user asked for the question to be put again more
 * clearly, and got the same sentence back. From inside the turn the question IS clear; only the tool can
 * see that what it refers to never reached a screen.
 */
describe("a question that points at items it never states", () => {
  it("refuses the question that was actually asked", async () => {
    const tool = buildAskUserTool(async () => "unreachable");
    const r = await tool.run(
      { question: "Lütfen Q1, Q2 ve Q3 için seçeneklerinizi belirtin. Örnek: Q1: B, Q2: A, Q3: C." },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Q1, Q2, Q3");
  });

  it("refuses the rephrasing too — asking for it again was what failed", async () => {
    const tool = buildAskUserTool(async () => "unreachable");
    const r = await tool.run(
      { question: "Q1, Q2 ve Q3 için seçiminizi ve varsa özel kurallarınızı yazın. Örnek: Q1: A, Q2: C, Q3: A." },
      ctx(),
    );
    expect(r.isError).toBe(true);
  });

  /** Being told to be clearer produced the same sentence; the way out has to be spelled out. */
  it("says what to do instead: one question at a time, each with its own options", async () => {
    const tool = buildAskUserTool(async () => "unreachable");
    const r = await tool.run({ question: "Answer Q1 and Q2, e.g. Q1: A, Q2: B." }, ctx());
    expect(r.content).toMatch(/one at a time/i);
    expect(r.content).toContain("`options`");
  });

  it("lets through a question that sets its items out", async () => {
    const rec = recorder();
    const tool = buildAskUserTool(rec.read);
    const r = await tool.run({
      question: [
        "İki karar var:",
        "Q1: Tedarikçi fiyatı nasıl belirlensin? A) Katalog B) Sabit oran",
        "Q2: Durum aynası nasıl güncellensin? A) Anlık B) Toplu",
      ].join("\n"),
    }, ctx());
    expect(r.isError).toBe(false);
    expect(rec.asked).toHaveLength(1);
  });

  /** A single named reference beside a written-out item is ordinary prose, not a dangling pointer. */
  it("does not refuse a question that merely mentions one item", async () => {
    const rec = recorder();
    const tool = buildAskUserTool(rec.read);
    const r = await tool.run({ question: "FR-016 kapsamda kalsın mı?" }, ctx());
    expect(r.isError).toBe(false);
  });

  /** The questions being on screen is the whole test — a turn that wrote them has satisfied it. */
  it("allows the reference when the turn wrote the questions itself", async () => {
    const rec = recorder();
    const tool = buildAskUserTool(rec.read);
    const r = await tool.run(
      { question: "Q1 ve Q2 için seçiminizi yazın." },
      ctx("Q1: Fiyat nasıl belirlensin?\nQ2: Durum nasıl yansısın?"),
    );
    expect(r.isError).toBe(false);
  });

  /** The reference resolves when there IS a message above it — that one is on the screen. */
  it("allows the reference when the turn said something", async () => {
    const rec = recorder();
    const tool = buildAskUserTool(makeAskUser(rec.read));
    const r = await tool.run(
      { question: "Report your observation per the 5 items above." },
      ctx("1. open the wizard\n2. …"),
    );
    expect(r.isError).toBe(false);
    expect(rec.asked).toHaveLength(1);
  });

  /** …and when the question carries the steps itself, there is nothing dangling to catch. */
  it("allows it when the steps travel with the question", async () => {
    const rec = recorder();
    const tool = buildAskUserTool(makeAskUser(rec.read));
    const r = await tool.run(
      { question: "What did you see in the 3 checks above?", steps: ["Open the wizard", "Submit", "Read the response"] },
      ctx(),
    );
    expect(r.isError).toBe(false);
    expect(rec.asked[0].opts?.steps).toEqual(["Open the wizard", "Submit", "Read the response"]);
  });

  it("numbers the actions into the prompt so the box carries them", async () => {
    const rec = recorder();
    await makeAskUser(rec.read)("What did you see?", { steps: ["Open the wizard", "Submit the form"] });
    expect(rec.asked[0].prompt).toContain("1. Open the wizard");
    expect(rec.asked[0].prompt).toContain("2. Submit the form");
    // The question stays last, because that is the line elision keeps when the list is long.
    expect(rec.asked[0].prompt.trimEnd().endsWith("What did you see?")).toBe(true);
  });

  it("is rendered as a hand-off rather than a question", async () => {
    const rec = recorder();
    await makeAskUser(rec.read)("What did you see?", { steps: ["Open the wizard"] });
    expect(parsePending(rec.asked[0].prompt).kind).toBe("action");
  });

  it("stays a question when there is nothing to do first", async () => {
    const rec = recorder();
    await makeAskUser(rec.read)("Which approach?", { options: ["a", "b"] });
    expect(parsePending(rec.asked[0].prompt).kind).toBe("question");
  });

  /**
   * A hand-off is not a multiple-choice question in disguise.
   *
   * The numbered actions are exactly the shape `looksLikeChoices` hunts for, and left alone it would have
   * turned "1. Open the wizard / 2. Submit" into a radio list of two options to pick between.
   */
  it("does not mistake the actions for choices", async () => {
    const rec = recorder();
    const tool = buildAskUserTool(makeAskUser(rec.read));
    await tool.run(
      { question: "1. Open the wizard\n2. Submit the form\nWhat did you see?", steps: ["Open the wizard", "Submit the form"] },
      ctx(),
    );
    expect(rec.asked[0].opts?.options ?? []).toHaveLength(0);
  });
});

/** The tester is the role that hands work to a person, so it is the one that has to be told where they look. */
describe("what the tester is told about the developer's screen", () => {
  it("says the document it writes is not on their screen", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/engine/verify.ts", "utf8");
    expect(src).toContain("The developer sees the chat and nothing else.");
    // The rule lives in a template literal, so its backticks are escaped in the source.
    expect(src).toMatch(/pass the actions to \\`ask_user\\` in \\`steps\\`/);
  });
});

/**
 * The tag is stripped everywhere the prompt is shown, not just in its box.
 *
 * Reported live: a hand-off rendered correctly — six numbered steps and the question, exactly as intended —
 * and then landed in the transcript reading `[action] 1. Tarayıcıda … aç`. The strip existed twice, in the
 * parser and in `TuiController.answer`, and adding `[action]` updated one of them. Two copies of the same
 * four words is a list that goes stale, and this one did so on the very first change after it was written.
 */
describe("the tag that says what kind of prompt it is", () => {
  it("is stripped from the transcript for every kind", async () => {
    const { TuiController } = await import("../../src/tui/controller.js");
    for (const kind of ["question", "action", "permission", "human"]) {
      const c = new TuiController();
      const asked = c.ask(`\n[${kind}] 1. Open the wizard\n\nWhat did you see?`);
      c.answer("all three matched");
      await asked;
      const said = c.getState().transcript.filter((t) => "role" in t && t.role === "assistant");
      expect(said.length, kind).toBe(1);
      const text = (said[0] as { text: string }).text;
      expect(text, kind).not.toContain(`[${kind}]`);
      expect(text, kind).toContain("1. Open the wizard");
    }
  });

  /** …and there is only ONE pattern, so the next kind added cannot go stale in half the places. */
  it("is defined once", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const f of ["src/tui/controller.ts", "src/tui/components.tsx"]) {
      const src = await readFile(f, "utf8");
      expect(src, f).toContain("PENDING_TAG");
      expect(src, f).not.toMatch(/\[\(question\|/); // no second copy of the alternation
    }
  });
});
