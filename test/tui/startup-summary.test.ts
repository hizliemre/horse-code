import { describe, it, expect } from "vitest";
import { startupSummary, type StartupFacts } from "../../src/tui/startup-summary.js";

const facts = (over: Partial<StartupFacts> = {}): StartupFacts => ({
  rules: 25,
  memory: { total: 1471, rules: 11, lessons: 34, facts: 1426 },
  skills: 76,
  constitution: true,
  graph: { built: true, nodes: 55081 },
  traces: 12,
  ...over,
});

/**
 * The launch banner printed every standing rule in full — twenty-five of them on a real project, a wall of
 * prose filling the screen before the user had typed anything, and unreadable precisely because it was
 * complete. The rules are already inlined into every agent's prompt; reprinting them costs a screen and says
 * nothing the user can act on.
 */
describe("the startup summary", () => {
  it("counts the rules instead of reciting them", () => {
    const s = startupSummary(facts());
    expect(s).toContain("Rules: 25 active");
    expect(s.split("\n")).toHaveLength(6); // header + five facts, before MCP answers
  });

  it("breaks memory down by kind, which is what makes the number mean anything", () => {
    expect(startupSummary(facts())).toContain("1471 entries — 11 rules · 34 lessons · 1426 facts");
  });

  /** A silent gap reads as everything being fine; the missing piece is the line worth reading. */
  it("states absences rather than omitting them", () => {
    const s = startupSummary(facts({ constitution: false, traces: 0, graph: { built: false, nodes: 0 } }));
    expect(s).toContain("not established yet");
    expect(s).toContain("not built");
    expect(s).toContain("no traces yet");
  });

  it("flags a graph that has fallen behind the code", () => {
    expect(startupSummary(facts({ graph: { built: true, nodes: 900, stale: true } }))).toContain("stale");
  });

  /** MCP connects in the background: no line at all until the servers have answered. */
  it("adds the MCP line only once there is something to say", () => {
    expect(startupSummary(facts())).not.toContain("MCP");
    expect(startupSummary(facts({ mcp: [{ name: "angular-cli", tools: 9 }] }))).toContain("angular-cli (9 tools)");
    expect(startupSummary(facts({ mcp: [] }))).toContain("none connected");
  });

  it("reads correctly for a brand-new project with nothing in it", () => {
    const s = startupSummary({
      rules: 0, memory: { total: 0, rules: 0, lessons: 0, facts: 0 }, skills: 0,
      constitution: false, graph: { built: false, nodes: 0 }, traces: 0,
    });
    expect(s).toContain("Rules: 0 active");
    expect(s).toContain("Memory: 0 entries");
    expect(s).not.toContain("—  ");
  });
});
