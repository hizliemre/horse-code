import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * A field the model fills in says what it means, where it is filled in.
 *
 * Three defects in one day came from the same shape: `grep`'s `flags` (the model wrote grep's command line
 * into a field for regex letters, ten times in one run), `intent` (a request to query the database and write
 * a test report was classified `feature`, and the run produced a constitution and a brainstorm before anyone
 * noticed), and the tool events that could not say which agent made them. In none of them was the model
 * behaving badly — each was filling a field nothing had ever described.
 *
 * The codebase's own habit made it worse: the reasoning was written in a JSDoc comment ABOVE the field,
 * which the compiler and the reader see and the model never does. Measured across the model-facing schemas:
 * 96 undescribed fields, 18 of them with the explanation sitting right above them.
 *
 * This guards the fields where a wrong value is expensive: an enum is a decision, and the option NAMES are
 * rarely enough to make it. Plain `z.string()` fields are left alone — `path` and `url` describe themselves.
 */

/** Schemas the model fills in: structured role outputs and tool parameters. */
function modelFacingFiles(): string[] {
  return execFileSync("git", ["ls-files", "src"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".ts"))
    // Written by a person into a file, or by us into one — no model ever fills these in.
    .filter((f) => f !== "src/config/config.ts" && f !== "src/board/board.ts")
    .filter((f) => {
      const s = readFileSync(f, "utf8");
      return s.includes("runStructuredRole") || s.includes("parameters:") || /Schema = z\.object/.test(s);
    });
}

describe("every enum a model must choose from is described", () => {
  it("names its options' meanings where the choice is made", () => {
    const bare: string[] = [];
    for (const file of modelFacingFiles()) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/z\.enum\(/.test(line)) return;
        // The description may run onto the following lines — read the whole definition.
        const defn = lines.slice(i, i + 8).join("\n");
        if (!defn.includes(".describe(")) bare.push(`${file}:${i + 1} ${line.trim().slice(0, 70)}`);
      });
    }
    expect(bare, `an enum is a decision; these do not say what their options mean:\n${bare.join("\n")}`)
      .toEqual([]);
  });
});
