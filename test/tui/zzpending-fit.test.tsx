import { describe, it, expect } from "vitest";
import React from "react";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { App, elideLines } from "../../src/tui/components.js";
import { TuiController } from "../../src/tui/controller.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
/**
 * EVERY write, not the last chunk.
 *
 * Ink repaints differentially, so one chunk is a partial update: reading it as a whole screen shows
 * characters "missing" that were simply not rewritten. A diagnosis was once built on that mistake — the
 * accumulated stream is what the terminal actually received.
 */
const screen = (rows: number, columns = 200) => {
  let all = "";
  const e = Object.assign(new EventEmitter(), { isTTY: true, columns, rows,
    write: (s: string) => { all += s; } });
  return { stdout: e, frame: (): string => all };
};

const RULES = Array.from({ length: 6 }, (_, i) =>
  `- Rule ${i} that is reasonably long and wraps across the terminal width easily.`).join("\n");
const QUESTION = `**12 standing rule(s)**. A rule goes into EVERY agent's instructions, for every task, `
  + `permanently.\n\n${RULES}\n- _…and 6 more_\n\nImport them?`;
const OPTIONS = [
  { label: "Yes — import all", description: "12 rules become permanent memory" },
  { label: "No", description: "Nothing is written; you can re-run /migrate later" },
];

/**
 * A question is asked WITH its options, and the options are the part the user has to act on.
 *
 * Measured on a real terminal: a twelve-rule import question rendered with BOTH option labels missing and
 * the question's own first characters gone — "2 standing rule(s)" for twelve. The user pressed Enter on a
 * choice they could not see and got "No", losing the import.
 */
/**
 * Waits for a frame to carry `text`, rather than sleeping and hoping.
 *
 * A fixed `setTimeout(80)` is a bet on how fast the machine renders. It paid out on a developer laptop and
 * lost on a two-core CI runner: the assertion read an EMPTY frame — `expected '' to contain 'Yes — import
 * all'` — four times over, once per terminal height. The test was never about timing; it is about what the
 * layout keeps when the terminal is short.
 *
 * So it polls to a deadline instead. A slow machine takes longer and still passes; a real layout regression
 * still fails, because the text never arrives however long it waits.
 */
const until = async (frame: () => string, text: string, ms = 4_000): Promise<string> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const f = strip(frame());
    if (f.includes(text) || Date.now() > deadline) return f;
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("a pending question never crowds out its own answers", () => {
  /**
   * 16 is the measured floor, not a preference: the answer box alone is ten rows (border, two labels, two
   * descriptions, the three-row note block, the hint), and the question needs a header and a line of its own.
   * Below that a terminal cannot hold a question WITH its options at all, and no layout rule changes it.
   */
  for (const rows of [16, 20, 24, 40]) {
    it(`keeps every option label at ${rows} rows`, async () => {
      const c = new TuiController();
      const { stdout, frame } = screen(rows);
      const app = render(<App controller={c} fullscreen />, { stdout: stdout as never, patchConsole: false, exitOnCtrlC: false });
      try {
        void c.ask(QUESTION, { options: OPTIONS });
        const f = await until(frame, "Yes — import all");
        expect(f).toContain("Yes — import all");
        expect(f).toContain("No");
        expect(f).toContain("Esc to type");       // …and the list is complete, not cut short

      } finally { app.unmount(); }
    });
  }

  /** The body yields, and says how much it took — a silent truncation reads as a rendering bug. */
  it("elides the middle of a long body rather than the answers", async () => {
    const c = new TuiController();
    const { stdout, frame } = screen(20);
    const app = render(<App controller={c} fullscreen />, { stdout: stdout as never, patchConsole: false, exitOnCtrlC: false });
    try {
      void c.ask(QUESTION, { options: OPTIONS });
      const f = await until(frame, "12 standing rule(s)");
      expect(f).toContain("12 standing rule(s)");  // the headline survives…
      expect(f).toContain("Import them?");         // …so does the actual question
      expect(f).toMatch(/… \d+ more line\(s\)/);   // …and the gap is named
    } finally { app.unmount(); }
  });
});

describe("elideLines", () => {
  const mark = (n: number): string => `…${n}`;
  it("returns the input untouched when it fits", () => {
    expect(elideLines(["a", "b"], 5, mark)).toEqual(["a", "b"]);
  });

  it("keeps the head and the closing line, naming what went", () => {
    expect(elideLines(["a", "b", "c", "d", "e"], 3, mark)).toEqual(["a", "…3", "e"]);
  });

  it("degrades to the marker alone rather than showing a misleading fragment", () => {
    expect(elideLines(["a", "b", "c"], 1, mark)).toEqual(["…2"]);
  });

  it("never returns more than asked for", () => {
    for (const max of [1, 2, 3, 4, 8]) {
      expect(elideLines(["a", "b", "c", "d", "e", "f"], max, mark).length).toBeLessThanOrEqual(max);
    }
  });
});
