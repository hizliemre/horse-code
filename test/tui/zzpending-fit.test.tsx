import { describe, it, expect } from "vitest";
import React from "react";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { App, elideLines } from "../../src/tui/components.js";
import { TuiController } from "../../src/tui/controller.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const screen = (rows: number, columns = 200) => {
  let last = "";
  const e = Object.assign(new EventEmitter(), { isTTY: true, columns, rows,
    write: (s: string) => { if (s.includes("\n")) last = s; } });
  return { stdout: e, frame: (): string => last };
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
describe("a pending question never crowds out its own answers", () => {
  for (const rows of [12, 16, 20, 24, 40]) {
    it(`keeps every option label at ${rows} rows`, async () => {
      const c = new TuiController();
      const { stdout, frame } = screen(rows);
      const app = render(<App controller={c} fullscreen />, { stdout: stdout as never, patchConsole: false, exitOnCtrlC: false });
      try {
        void c.ask(QUESTION, { options: OPTIONS });
        await new Promise((r) => setTimeout(r, 80));
        const f = strip(frame());
        expect(f).toContain("Yes — import all");
        expect(f).toContain("No");
        expect(f).toContain("Esc to type");       // …and the list is complete, not cut short
        expect(f.replace(/\n$/, "").split("\n").length).toBeLessThanOrEqual(rows);
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
      await new Promise((r) => setTimeout(r, 80));
      const f = strip(frame());
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
