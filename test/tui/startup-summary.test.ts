import { describe, it, expect } from "vitest";
import { startupSummary, type StartupFacts } from "../../src/tui/startup-summary.js";

const facts = (over: Partial<StartupFacts> = {}): StartupFacts => ({
  rules: 25,
  memory: { total: 1471, rules: 11, lessons: 34, facts: 1426 },
  skills: 76,
  constitution: true,
  graph: { built: true, nodes: 55081 },
  traces: 12,
  traceRoot: ".horsecode/traces",
  ...over,
});

/**
 * The launch banner printed every standing rule in full — twenty-five of them on a real project, a wall of
 * prose filling the screen before the user had typed anything, and unreadable precisely because it was
 * complete. The rules are already inlined into every agent's prompt; reprinting them costs a screen and says
 * nothing the user can act on.
 */
describe("the startup summary", () => {
  /**
   * The word is taken: a real project keeps 58 architecture traces of its own under `docs/architecture/`.
   * "No traces yet" was true of horse-code's per-file traces and false of that project, and read as the tool
   * having missed what is plainly in the repository.
   */
  it("names WHICH traces it means, and where they live", () => {
    expect(startupSummary(facts())).toContain("`.horsecode/traces`");
    expect(startupSummary(facts({ traces: 0 }))).toContain(".horsecode/traces");
    expect(startupSummary(facts({ traces: 0 }))).not.toMatch(/no traces\b/);
  });

  /** The location is configurable, so spelling it into the sentence would make the sentence lie. */
  it("names the project's OWN trace root, not the default", () => {
    const s = startupSummary(facts({ traceRoot: "docs/architecture", traces: 0 }));
    expect(s).toContain("docs/architecture");
    expect(s).not.toContain(".horsecode/traces");
    expect(startupSummary(facts({ traceRoot: "docs/architecture", traces: 424 }))).toContain("424 file traces in `docs/architecture`");
  });

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
    expect(s).toContain("no per-file traces");
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
      constitution: false, graph: { built: false, nodes: 0 }, traces: 0, traceRoot: ".horsecode/traces",
    });
    expect(s).toContain("Rules: 0 active");
    expect(s).toContain("Memory: 0 entries");
    expect(s).not.toContain("—  ");
  });
});

/**
 * A trace count with no denominator reads as completeness.
 *
 * Reported live: `/graph trace` queued 226 files on a project whose start-up screen had said
 * "2,445 file traces in `docs/architecture`" — a true number that told the user nothing, because what they
 * needed was the 226. Measured on that run: 76 of the files had never been traced and 89 had a trace
 * describing code that had since changed. Both are gaps; only one is a MISSING trace, and a stale one is
 * worse — every agent that reads it is being told something that is no longer true — so they are named apart.
 */
describe("how much of the project the graph actually describes", () => {
  const base = {
    rules: 0, memory: { total: 0, rules: 0, lessons: 0, facts: 0 }, skills: 0,
    traceRoot: "docs/architecture", constitution: true, graph: { built: true, nodes: 55_081 },
  };

  it("states what is missing and what has drifted", () => {
    const s = startupSummary({ ...base, traces: 2445, coverage: { traceable: 2524, current: 2445, missing: 28, stale: 51 } });
    expect(s).toContain("2,445/2,524 files traced in `docs/architecture`");
    expect(s).toContain("28 untraced, 51 stale (`/graph trace`)");
  });

  it("says so plainly when there is nothing outstanding", () => {
    const s = startupSummary({ ...base, traces: 2524, coverage: { traceable: 2524, current: 2524, missing: 0, stale: 0 } });
    expect(s).toContain("all 2,524 files traced");
    expect(s).not.toContain("/graph trace");
  });

  it("names only the gap that exists", () => {
    const s = startupSummary({ ...base, traces: 2445, coverage: { traceable: 2524, current: 2445, missing: 0, stale: 79 } });
    expect(s).toContain("79 stale");
    expect(s).not.toContain("untraced,");
  });

  /** The count arrives before the coverage pass finishes, and the line has to work in between. */
  it("falls back to the bare count while the pass is still running", () => {
    const s = startupSummary({ ...base, traces: 2445 });
    expect(s).toContain("2445 file traces in `docs/architecture`");
  });

  it("still points at `/graph trace` when a project has nothing", () => {
    const s = startupSummary({ ...base, traces: 0, coverage: { traceable: 2524, current: 0, missing: 2524, stale: 0 } });
    expect(s).toContain("no per-file traces for 2,524 files");
    expect(s).toContain("`/graph trace`");
  });
});

/**
 * A number nobody has taken yet is not a zero.
 *
 * Reported live on a project with 2,500 traces on disk: the summary said "no per-file traces (`/graph trace`
 * writes them under `docs/architecture`)" and kept saying it for as long as the graph rebuild in front of it
 * took. The count was not wrong — it had not been read. A placeholder rendered as a definite absence sends
 * the user to spend a 2,500-file trace run they do not need, which is the one outcome the line exists to
 * prevent.
 */
describe("before the trace index has been read", () => {
  const base = {
    rules: 0, memory: { total: 0, rules: 0, lessons: 0, facts: 0 }, skills: 0,
    traceRoot: "docs/architecture", constitution: true, graph: { built: true, nodes: 44_210, stale: true },
  };

  it("says it is still looking, and recommends nothing", () => {
    const s = startupSummary(base);
    expect(s).toContain("reading file traces in `docs/architecture`…");
    expect(s).not.toContain("no per-file traces");
    expect(s).not.toContain("/graph trace");
  });

  it("says there are none only once it has looked", () => {
    const s = startupSummary({ ...base, traces: 0 });
    expect(s).toContain("no per-file traces");
    expect(s).toContain("`/graph trace`");
  });
});

/**
 * …and the index is read BEFORE the graph rebuild it does not depend on.
 *
 * Ordering is the actual fix: the placeholder was only ever on screen because the cheap read sat behind a
 * rebuild that takes minutes. Asserted on the source, because the block runs against a live checkout.
 */
describe("the order the start-up facts are gathered in", () => {
  it("reads the trace index before rebuilding the graph", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/tui/app.tsx", "utf8");
    const readIndex = src.indexOf("startupExtra.traces = Object.keys(index.traces).length");
    const rebuild = src.indexOf("await refreshGraphIfStale()");
    expect(readIndex).toBeGreaterThan(-1);
    expect(rebuild).toBeGreaterThan(-1);
    expect(readIndex).toBeLessThan(rebuild);
  });
});

/**
 * The one line a person came back for.
 *
 * The screen listed what the session has to work WITH — constitution, rules, memory, skills, graph, MCP — and
 * said nothing about what it had been DOING. Measured live: a run stopped with 126 commits and 11 of 12 tasks
 * finished, and the next start-up mentioned none of it.
 */
describe("work a previous run left behind", () => {
  const base = {
    rules: 0, memory: { total: 0, rules: 0, lessons: 0, facts: 0 }, skills: 0, traces: 0,
    traceRoot: "docs/architecture", constitution: true, graph: { built: true, nodes: 1 },
  };

  it("is on the screen when there is some", () => {
    const s = startupSummary({ ...base, unfinished: ['“fix the wizard” — plan done · 11/12 tasks · 126 commits'] });
    expect(s).toContain("- Unfinished: “fix the wizard”");
    expect(s).toContain("126 commits");
  });

  it("lists every session, newest first", () => {
    const s = startupSummary({ ...base, unfinished: ["first one", "second one"] });
    expect(s).toContain("- Unfinished: first one");
    expect(s).toContain("  · second one");
  });

  /** A project with nothing pending must not gain a line saying so — the absence IS the answer. */
  it("says nothing when there is none", () => {
    expect(startupSummary(base)).not.toContain("Unfinished");
    expect(startupSummary({ ...base, unfinished: [] })).not.toContain("Unfinished");
  });

  /** …and it is read at start-up, not left as a field nobody fills. */
  it("is filled in by the start-up path", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/tui/app.tsx", "utf8");
    expect(src).toContain("unfinishedSessions(process.cwd(), sessionCommitCount).map(describeUnfinished)");
    expect(src).toContain("...(unfinished.length ? { unfinished } : {})");
  });
});
