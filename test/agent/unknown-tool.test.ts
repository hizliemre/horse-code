import { describe, it, expect } from "vitest";
import { unknownTool } from "../../src/agent/tool-exec.js";

/**
 * Observed on a real run: a project-manager invented an MCP tool that was never registered for it, and spent
 * SEVEN turns extending the name one fragment at a time — `…list_projects_ide`, `…_9564507f_ide`,
 * `…_9564507f2f_ide`, `…_9564507f2f430e1e52_ide` — before the phase died without writing its file. 133
 * minutes and 18M input tokens, ended by a message that had the answer and did not give it: the entire text
 * was `unknown tool: <name>`.
 */
describe("unknown tool: the message a model can act on", () => {
  const TOOLS = ["read_file", "write_file", "grep", "glob", "git", "submit"];

  it("names the closest tool when the name is a near miss", () => {
    const msg = unknownTool("read_files", TOOLS);
    expect(msg).toContain("Did you mean `read_file`?");
  });

  it("lists what exists, always — 'no such tool' is only useful beside 'these do'", () => {
    const msg = unknownTool("mcp_angular_cli_list_projects_9564507f2f430e1e52_ide", TOOLS);
    for (const t of TOOLS) expect(msg).toContain(t);
  });

  it("tells it not to guess, which is what it did seven times", () => {
    expect(unknownTool("whatever", TOOLS)).toMatch(/do not guess/i);
  });

  it("offers no suggestion when nothing is close, rather than a misleading one", () => {
    expect(unknownTool("zzzzzz", TOOLS)).not.toContain("Did you mean");
  });

  it("survives an empty toolset without pretending something is close", () => {
    const msg = unknownTool("anything", []);
    expect(msg).toContain("unknown tool: anything");
    expect(msg).not.toContain("Did you mean");
  });
});
