import { describe, it, expect } from "vitest";
import { helpSections } from "../../src/tui/help.js";
import { COMMANDS } from "../../src/tui/commands.js";

describe("helpSections", () => {
  it("groups keybindings and lists every slash command", () => {
    const secs = helpSections();
    const titles = secs.map((s) => s.title);
    expect(titles).toContain("Editing");
    expect(titles).toContain("Navigation");
    expect(titles).toContain("Commands");

    const cmds = secs.find((s) => s.title === "Commands")!;
    expect(cmds.entries.map((e) => e.keys)).toEqual(COMMANDS.map((c) => c.name));
  });

  it("surfaces the core keybindings (Alt+V, ?, Ctrl+C)", () => {
    const keys = helpSections().flatMap((s) => s.entries.map((e) => e.keys));
    expect(keys).toContain("Alt+V");
    expect(keys).toContain("?");
    expect(keys).toContain("Ctrl+C");
  });

  it("every entry has a non-empty description", () => {
    for (const s of helpSections()) for (const e of s.entries) expect(e.desc.length).toBeGreaterThan(0);
  });
});
