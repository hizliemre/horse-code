import { describe, it, expect } from "vitest";
import { projectToolsNote, MAX_TOOL_NOTE_CHARS } from "../../src/engine/task-types.js";
import type { Tool } from "../../src/core/types.js";

const tool = (name: string, description: string): Tool => ({ name, description } as Tool);

/** The real profile of a connected Angular CLI server. */
const ANGULAR: Tool[] = [
  tool("mcp__angular-cli__search_documentation", "[MCP:angular-cli] Search the Angular documentation. Returns excerpts."),
  tool("mcp__angular-cli__get_best_practices", "[MCP:angular-cli] Return Angular best practices for the installed version"),
  tool("mcp__angular-cli__list_projects", "[MCP:angular-cli] List applications and libraries in the workspace"),
];

/**
 * Registering a tool puts it in the list; it does not make an agent reach for it.
 *
 * A coder with fifteen tools writing Angular will recall Angular from training — which for a fast-moving
 * framework means recalling a version the project is not on — unless something says an authoritative source
 * is right there.
 */
describe("projectToolsNote", () => {
  it("names each project tool with what it is for", () => {
    const note = projectToolsNote(ANGULAR);
    expect(note).toContain("mcp__angular-cli__search_documentation");
    expect(note).toContain("Search the Angular documentation");
  });

  // The tool's own description is already in the prompt; repeating it whole pays for the same text twice.
  it("keeps only the first sentence of each description", () => {
    expect(projectToolsNote(ANGULAR)).not.toContain("Returns excerpts");
  });

  it("drops the server bracket, which says nothing the name does not", () => {
    expect(projectToolsNote(ANGULAR)).not.toContain("[MCP:angular-cli]");
  });

  /** The one principle that changes behaviour: prefer the tool to recollection. */
  it("says why to prefer them over what the model remembers", () => {
    const note = projectToolsNote(ANGULAR);
    expect(note).toMatch(/instead of relying on what you remember/);
    expect(note).toMatch(/Your training is a snapshot/);
  });

  // It goes into every prompt this agent makes, for every task.
  it("is nothing at all when no project tools are connected", () => {
    expect(projectToolsNote([tool("read_file", "Reads a file"), tool("grep", "Searches")])).toBe("");
  });

  it("ignores the agent's own tools", () => {
    const note = projectToolsNote([...ANGULAR, tool("shell", "Runs a command")]);
    expect(note).not.toContain("shell");
  });

  it("caps its length however many tools are connected", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      tool(`mcp__server__tool_${i}`, `[MCP:server] Does a fairly long thing number ${i} with detail`));
    expect(projectToolsNote(many).length).toBeLessThan(MAX_TOOL_NOTE_CHARS + 400);
  });
});
