import { describe, it, expect } from "vitest";
import { COMMANDS, matchCommands, helpText } from "../../src/tui/commands.js";

describe("slash commands", () => {
  it("matchCommands returns nothing unless the draft starts with '/'", () => {
    expect(matchCommands("")).toEqual([]);
    expect(matchCommands("hello")).toEqual([]);
    expect(matchCommands("model")).toEqual([]);
  });

  it("'/' alone lists every command", () => {
    expect(matchCommands("/")).toEqual(COMMANDS);
  });

  it("filters by prefix (case-insensitive) and trims", () => {
    expect(matchCommands("/cl").map((c) => c.name)).toEqual(["/clear"]);
    expect(matchCommands("  /MO  ").map((c) => c.name)).toEqual(["/model"]);
    expect(matchCommands("/xyz")).toEqual([]);
  });

  it("helpText lists each command with its description, one per line", () => {
    const lines = helpText().split("\n");
    expect(lines).toHaveLength(COMMANDS.length);
    expect(lines[0]).toContain("/model");
    expect(helpText()).toContain("/exit");
  });
});
