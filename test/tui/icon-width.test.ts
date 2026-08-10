import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import stringWidth from "string-width";

/**
 * An icon a terminal draws two columns wide, that we count as one.
 *
 * This is a defect class this codebase has paid for more than once — the selection markers `◉`/`○`/`›` were
 * replaced with plain ASCII for exactly this reason (see components.tsx), after every option's marker line
 * came out blank in a real terminal. The milder form is what a user photographed: `🗂` measured one column,
 * the terminal drew two, and the space after it was swallowed, so the icon ran into the text.
 *
 * The rule this enforces is narrow on purpose: a character in the pictographic emoji blocks is drawn as a
 * colour emoji by every terminal font, so it MUST also measure two. Text symbols (arrows, box drawing, `⚠`,
 * `⏸`, `✓`) are left alone — they measure one and are drawn as one, which is consistent and intended.
 *
 * The fix when this fails is a variation selector: `🗂` → `🗂️` (U+FE0F), which is what `⚠️`, `👁️`, `♻️` and
 * `⏱️` already carry in this codebase.
 */

/** The blocks whose characters terminals render as colour emoji regardless of a variation selector. */
const PICTOGRAPHIC = /[\u{1F300}-\u{1FAFF}]/u;

function sourceFiles(): string[] {
  return execFileSync("git", ["ls-files", "src"], { encoding: "utf8" })
    .split("\n").filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
}

describe("icons in source strings", () => {
  it("every pictographic emoji measures the two columns a terminal draws it in", () => {
    const bad: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        // Each pictograph WITH whatever variation selector follows it — that pair is what gets measured.
        for (const m of line.matchAll(/[\u{1F300}-\u{1FAFF}][\u{FE0E}\u{FE0F}]?/gu)) {
          const icon = m[0];
          if (!PICTOGRAPHIC.test(icon)) continue;
          if (icon.endsWith("︎")) continue; // explicitly asked for text presentation — a deliberate choice
          if (stringWidth(icon) !== 2) {
            const cp = [...icon].map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase()}`).join(" ");
            bad.push(`${file}:${i + 1} ${JSON.stringify(icon)} (${cp}) measures ${stringWidth(icon)}`);
          }
        }
      });
    }
    expect(bad, `add U+FE0F to these so their measured width matches what the terminal draws:\n${bad.join("\n")}`)
      .toEqual([]);
  });

  it("catches the shape of the bug it was written for", () => {
    // 🗂 without the variation selector is the exact character that shipped broken.
    expect(stringWidth("\u{1F5C2}")).toBe(1);
    expect(stringWidth("\u{1F5C2}️")).toBe(2);
  });
});
