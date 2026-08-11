import { describe, it, expect } from "vitest";
import { mcpToolAdapter } from "../../src/mcp/registry.js";
import { buildFindToolTool } from "../../src/tools/find-tool.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ToolContext } from "../../src/core/types.js";

/**
 * A tool that has proven it cannot answer is withdrawn for the rest of the run.
 *
 * `explainMcpError` already told the agent a server fault would "fail identically" — and that lesson died
 * with the agent that learned it. Measured on a real run: `mcp__angular-cli__list_projects` declares
 * `workspaces`, `parsingErrors` and `versioningErrors` as required output; the workspace it was pointed at
 * has no `angular.json` at all, so it answered in plain text and its own schema rejected it. Twenty-odd
 * calls, from eight different roles, each a fresh agent paying the same turn for the same answer.
 */

const ctx = (): ToolContext => ({ cwd: ".", signal: new AbortController().signal } as ToolContext);

/** A connection whose tool always fails the way a broken server does. */
function brokenConn(counter: { calls: number }) {
  return {
    name: "angular-cli",
    async callTool() {
      counter.calls++;
      throw new Error("structured content does not match the tool's output schema: "
        + "data must have required property 'parsingErrors'");
    },
  } as never;
}

const listProjects = { name: "list_projects", description: "Lists projects", inputSchema: {} } as never;

describe("withdrawing a broken MCP tool", () => {
  it("calls the server once, then answers without it", async () => {
    const counter = { calls: 0 };
    const t = mcpToolAdapter(brokenConn(counter), listProjects);

    const first = await t.run({}, ctx());
    expect(first.isError).toBe(true);
    expect(counter.calls).toBe(1);

    const second = await t.run({}, ctx());
    expect(second.isError).toBe(true);
    expect(counter.calls).toBe(1);              // the server was not troubled a second time
    expect(second.content).toMatch(/withdrawn for this run/);
    expect(second.content).toMatch(/fails its own declared schema/);
  });

  it("says why, rather than going quiet", async () => {
    const t = mcpToolAdapter(brokenConn({ calls: 0 }), listProjects);
    await t.run({}, ctx());
    expect(t.broken).toMatch(/will not be called again/);
  });

  it("is not offered by find_tool once withdrawn", async () => {
    const t = mcpToolAdapter(brokenConn({ calls: 0 }), listProjects);
    const r = new ToolRegistry();
    r.registerDeferred(t);
    const find = buildFindToolTool(r);

    const before = await find.run({ query: "list projects" }, ctx());
    expect(before.content).toContain("list_projects");

    await t.run({}, ctx());                     // it breaks

    const after = await find.run({ query: "list projects" }, ctx());
    expect(after.content).not.toContain("mcp__angular-cli__list_projects");
  });

  it("keeps a tool whose call was merely WRONG — that one the agent can correct", async () => {
    let calls = 0;
    const conn = {
      name: "azure-devops",
      async callTool() { calls++; throw new Error("Invalid arguments: missing required parameter 'project'"); },
    } as never;
    const t = mcpToolAdapter(conn, { name: "repo_file", description: "d", inputSchema: {} } as never);

    await t.run({}, ctx());
    expect(t.broken).toBeUndefined();           // a bad call is not a broken tool
    await t.run({ project: "x" }, ctx());
    expect(calls).toBe(2);                      // …so it is still tried
  });
});
