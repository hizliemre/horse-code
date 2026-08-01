import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { PendingQuestion, pendingBodyWidth } from "../../src/tui/components.js";
import { flattenMarkdown } from "../../src/tui/lines.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * The body was wrapped to a width two columns wider than the box it is drawn in: `pendingBodyWidth` accounts
 * for the outer Box's indent but not the inner one's, so Ink re-wrapped every line that fell between the two
 * widths. Each re-wrap is a row nobody counted — the block renders taller than the layout reserved, the frame
 * overflows the terminal, and the terminal scrolls the TOP away.
 *
 * That is what the user saw, three times: the first bullet of the question gone, the first character of its
 * bold header gone ("25 standing rule(s)" arriving as "5 standing rule(s)"), and the option labels pushed off
 * the screen entirely — so they answered a question whose choices they could not read.
 */
describe("a pending question is wrapped to the width it is drawn in", () => {
  const LONG = "Never commit or push unless the user explicitly asks (an explicit \"commit\", the \"cp\" "
    + "shorthand, or an \"o\" approval). \"cp\" means: stage the relevant changes, commit in Conventional "
    + "Commits format, and push to the current branch's tracked remote without asking further.";
  const BODY = `**25 standing rule(s)**. A rule goes into EVERY agent's instructions, for every task, `
    + `permanently.\n\n- ${LONG}\n- ${LONG}\n\nImport them?`;

  // Widths where a line falls between the two wrap widths differ by content, so the sweep is wide.
  for (const cols of [60, 70, 80, 90, 100, 120, 160, 200, 250]) {
    it(`renders exactly the lines it counted at ${cols} columns`, () => {
      const counted = flattenMarkdown(BODY, pendingBodyWidth(cols)).length;
      const { lastFrame } = render(<PendingQuestion cols={cols} text={BODY} />);
      const drawn = strip(lastFrame() ?? "").replace(/\n$/, "").split("\n").length;
      expect(drawn).toBe(counted + 1); // + the "? Question" header
    });
  }

  it("keeps the first character of a bold run at the head of the body", () => {
    const { lastFrame } = render(<PendingQuestion cols={120} text={BODY} />);
    expect(strip(lastFrame() ?? "")).toContain("25 standing rule(s)");
  });
});
