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
