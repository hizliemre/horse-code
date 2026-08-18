import { describe, it, expect } from "vitest";
import { errorExcerpt, MAX_ERROR_EXCERPT } from "../../src/agent/tool-exec.js";

/**
 * `hc.result_chars: 464` is not a diagnosis.
 *
 * Two shell failures in one live run each took a manual re-run to tell apart: one was prettier reporting an
 * unformatted file (exit 1, working correctly), the other a plugin that would not resolve. Identical in the
 * log. See errorExcerpt for why this is recorded on failures only.
 */
describe("errorExcerpt", () => {
  it("keeps a short failure whole — that is the sentence you need", () => {
    expect(errorExcerpt("grep: \"-rn\" is not a regex flag."))
      .toBe("grep: \"-rn\" is not a regex flag.");
  });

  it("collapses the newlines a shell error arrives with, so one failure is one log line", () => {
    expect(errorExcerpt("Checking formatting...\n[warn] a.ts\n[warn] Code style issues found."))
      .toBe("Checking formatting... [warn] a.ts [warn] Code style issues found.");
  });

  it("cuts a long one and says it cut it", () => {
    const said = errorExcerpt("x".repeat(MAX_ERROR_EXCERPT + 50));
    expect(said.length).toBe(MAX_ERROR_EXCERPT + 1);
    expect(said.startsWith("…")).toBe(true);
  });

  /**
   * A shell result opens with `$ <command>`; the reason it failed is at the other end. Measured live: a
   * failed inline python heredoc recorded 300 characters of its own source and no error at all, while the
   * command was already in `hc.tool.key`.
   */
  it("keeps the END, where a tool says what went wrong", () => {
    const command = `$ python3 - <<'PY' ${"import x ".repeat(60)}`;
    const said = errorExcerpt(`${command}\nTraceback: ConnectionRefusedError [Errno 61]`);
    expect(said).toContain("ConnectionRefusedError");
    expect(said).toContain("[Errno 61]");
  });

  it("survives a tool that failed with nothing to say", () => {
    expect(errorExcerpt(undefined)).toBe("");
    expect(errorExcerpt("   ")).toBe("");
  });
});

/**
 * …and the FIRST line too, because for one tool the rule above is backwards.
 *
 * `edit_file` says what went wrong first and then quotes the file: "oldString not found (plan.md) — the text
 * IS in the file, but its whitespace differs", then the block. Keeping only the end recorded the quoted
 * paragraph and none of the diagnosis — twice in one run a monitor line was six words of a Turkish spec and
 * nothing about the failure, and each took a query against the trace to classify.
 */
describe("a failure that says the useful part FIRST", () => {
  const block = "Bu bölüm sipariş akışını anlatır. ".repeat(30);

  it("keeps the diagnosis, not only the quoted file", () => {
    const said = errorExcerpt(`edit_file: oldString not found (plan.md) — the text IS in the file, but its `
      + `whitespace differs from what you sent. Here it is exactly as the file has it, from line 42:\n${block}`);
    expect(said).toContain("oldString not found (plan.md)");
    expect(said).toContain("whitespace differs");
  });

  it("still shows how it ended, within the budget", () => {
    const said = errorExcerpt(`edit_file: oldString not found (plan.md) — short reason.\n${block}`);
    expect(said).toContain("short reason.");
    expect(said).toContain("sipariş akışını");
    expect(said.length).toBeLessThanOrEqual(MAX_ERROR_EXCERPT + 40);
  });

  /** The shell case is untouched: its first line is the command, and the command is already in the key. */
  it("still drops a `$ command` opening and keeps the end", () => {
    const command = `$ python3 - <<'PY' ${"import x ".repeat(60)}`;
    const said = errorExcerpt(`${command}\nTraceback: ConnectionRefusedError [Errno 61]`);
    expect(said).toContain("ConnectionRefusedError");
    expect(said).not.toContain("python3");
  });
});
