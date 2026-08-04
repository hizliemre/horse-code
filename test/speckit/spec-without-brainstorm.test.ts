import { describe, it, expect } from "vitest";
import { specifyMessage } from "../../src/speckit/phases.js";

/**
 * The brainstorm is optional in the code and was mandatory in the prompt.
 *
 * `ensureWritten(..., optional = true)` says so in as many words — "a brief the model failed to write must
 * not kill the run — the spec prompt simply finds no file to read". But the spec prompt told the analyst to
 * read it FIRST and to honour the decisions in it, with no allowance for its absence.
 *
 * Measured from a live run: the analyst refused, correctly by its own instructions — "Since you specified
 * that the spec must honor the decisions in that file, I need the file to proceed without re-litigating the
 * approach" — and the run died with "specify did not produce spec.md".
 */
describe("the spec phase when there is no brief", () => {
  it("tells the analyst to read the brief when it is there", () => {
    const msg = specifyMessage("add a login page", "specs/001-x/spec.md", "specs/001-x/brainstorm.md", true, "TEMPLATE");
    expect(msg).toContain("specs/001-x/brainstorm.md");
    expect(msg).toMatch(/already decided/i);
  });

  it("does not demand a brief that was never written", () => {
    const msg = specifyMessage("add a login page", "specs/001-x/spec.md", "specs/001-x/brainstorm.md", false, "TEMPLATE");
    expect(msg).not.toContain("brainstorm.md");
    expect(msg).toMatch(/no design brief/i);       // …it says so, rather than leaving a silence to interpret
    expect(msg).toContain("specs/001-x/spec.md");   // …and still says where the spec goes
  });

  /** Revision is a third case: there IS a spec, and the reviewer's notes are what it must answer. */
  it("carries reviewer feedback without mentioning the brief at all", () => {
    const msg = specifyMessage("add a login page", "specs/001-x/spec.md", "specs/001-x/brainstorm.md", true, "T", ["too vague"]);
    expect(msg).toContain("too vague");
    expect(msg).toContain("specs/001-x/spec.md");
  });
});
