import { describe, it, expect } from "vitest";
import { rewritesAFile, shellTool } from "../../src/tools/shell.js";

/**
 * An 813-line test document was edited entirely through `shell`, forty-two times, with python heredocs
 * calling `write_text`. `edit_file` was never called on it once.
 *
 * Each of those writes is invisible to the read cache, so the document was read back from scratch to check
 * the result — twenty-eight times, 654,354 characters — and all of it stayed in the conversation, which
 * reached 168 messages and 190,000 characters per call before the run was stopped.
 */
describe("a shell command that rewrites a file", () => {
  it("is recognised in the shapes agents actually use", () => {
    for (const cmd of [
      `python3 - <<'PY'\nfrom pathlib import Path\nPath('doc.md').write_text(s)\nPY`,
      "sed -i '' 's/PENDING/PASSED/' docs/test-plan.md",
      "sed -i.bak s/a/b/ file.md",
      "perl -i -pe 's/x/y/' notes.md",
      "node -e \"require('fs').writeFileSync('a.json', x)\"",
      "python3 -c \"open('report.md','w').write(t)\"",
      "echo done > docs/report.md",
      "cat body >> docs/test-plan.md",
    ]) expect(rewritesAFile(cmd), cmd).toBeDefined();
  });

  /** Reading, searching and running things are none of its business. */
  it("leaves everything else alone", () => {
    for (const cmd of [
      "git status --short", "npm test", "grep -R 'needle' src", "sed -n '1,16p' docs/plan.md",
      "ls -la", "cat docs/plan.md", "npx nx build beempa", "curl -s https://example.com",
      "python3 -c \"print(open('a.md').read())\"",
      "echo hello > /dev/null", "npm ci 2>&1 | tail -5",
    ]) expect(rewritesAFile(cmd), cmd).toBeUndefined();
  });

  it("refuses, and says which tool to use instead", async () => {
    const res = await shellTool.run({ command: "sed -i '' s/a/b/ doc.md" },
      { cwd: process.cwd(), signal: new AbortController().signal } as never);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("edit_file");
    expect(res.content).toContain("write_file");
  });

  /**
   * Refused rather than discouraged, the way the git tool refuses a write: a description is advice, and the
   * same run also called `grep` four times with `-n -i <paths>`, which its description had already ruled out.
   */
  it("still says so in the description, for the model that reads it", () => {
    expect(shellTool.description).toContain("edit_file");
  });
});
