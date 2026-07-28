import { describe, it, expect } from "vitest";
import { COMMANDS, matchCommands, helpText } from "../../src/tui/commands.js";

describe("slash commands", () => {
  it("matchCommands returns nothing unless the draft starts with '/'", () => {
    expect(matchCommands("")).toEqual([]);
    expect(matchCommands("hello")).toEqual([]);
    expect(matchCommands("model")).toEqual([]);
  });

  it("'/' alone lists every command", () => {
    expect(matchCommands("/").map((c) => c.name).sort()).toEqual(COMMANDS.map((c) => c.name).sort());
  });

  /**
   * Declaration order put `/model` above `/mode` for the query "/mod": the exact word the user had finished
   * typing sat under a longer command that merely extends it.
   */
  it("puts the shorter name first, then orders alphabetically", () => {
    expect(matchCommands("/mod").map((c) => c.name)).toEqual(["/mode", "/model"]);
    const names = matchCommands("/").map((c) => c.name);
    const lengths = names.map((n) => n.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b)); // never a longer name above a shorter one
  });

  it("orders same-length names alphabetically", () => {
    const five = matchCommands("/").filter((c) => c.name.length === 5).map((c) => c.name);
    expect(five).toEqual([...five].sort());
  });

  it("filters by prefix (case-insensitive) and trims", () => {
    expect(matchCommands("/clea").map((c) => c.name)).toEqual(["/clear"]);
    expect(matchCommands("  /MOD  ").map((c) => c.name).sort()).toEqual(["/mode", "/model"]); // both match /mod
    expect(matchCommands("/xyz")).toEqual([]);
  });

  it("helpText lists each command with its description, one per line", () => {
    const lines = helpText().split("\n");
    expect(lines).toHaveLength(COMMANDS.length);
    expect(lines[0]).toContain("/model");
    expect(helpText()).toContain("/exit");
  });

  it("surfaces the session commands (/sessions, /resume)", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names).toContain("/sessions");
    expect(names).toContain("/resume");
    expect(matchCommands("/res").map((c) => c.name)).toEqual(["/resume"]);
    expect(matchCommands("/sess").map((c) => c.name)).toEqual(["/sessions"]);
  });

  it("does NOT surface the internal spec-kit phase commands (they confuse users)", () => {
    const names = COMMANDS.map((c) => c.name);
    for (const internal of ["/constitution", "/specify", "/clarify", "/plan", "/tasks"]) {
      expect(names).not.toContain(internal);
    }
    expect(matchCommands("/")).toHaveLength(COMMANDS.length); // only horse-code's own session commands
  });
});
