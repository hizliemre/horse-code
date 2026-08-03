import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphImpactTool, graphFindTool, graphContextTool, graphOverviewTool, MAX_ROWS } from "../../src/tools/graph.js";
import { parseGraph } from "../../src/engine/project-graph.js";

let cwd: string;
const ctx = () => ({ cwd, signal: new AbortController().signal }) as never;

/**
 * A miniature version of what graphify writes: networkx node-link JSON.
 *
 *   config.ts contains loadConfig, which cli.ts imports and main() calls.
 *   helper() is called by nothing.
 */
const FIXTURE = {
  directed: true,
  nodes: [
    { id: "config", label: "config.ts", source_file: "src/config.ts", source_location: "L1" },
    { id: "config_load", label: "loadConfig()", source_file: "src/config.ts", source_location: "L136" },
    { id: "cli", label: "cli.ts", source_file: "src/cli.ts", source_location: "L1" },
    { id: "cli_main", label: "main()", source_file: "src/cli.ts", source_location: "L93" },
    { id: "app", label: "app.ts", source_file: "src/app.ts", source_location: "L1" },
    { id: "helper", label: "helper()", source_file: "src/util.ts", source_location: "L4" },
  ],
  links: [
    { source: "config", target: "config_load", relation: "contains" },
    { source: "cli", target: "config_load", relation: "imports" },
    { source: "cli_main", target: "config_load", relation: "calls" },
    { source: "app", target: "cli_main", relation: "calls" },
  ],
};

const seed = async (doc: unknown = FIXTURE): Promise<void> => {
  await mkdir(join(cwd, "graphify-out"), { recursive: true });
  await writeFile(join(cwd, "graphify-out", "graph.json"), JSON.stringify(doc), "utf8");
};

beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "hc-graph-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

describe("parseGraph", () => {
  it("indexes nodes and edges", () => {
    const g = parseGraph(JSON.stringify(FIXTURE))!;
    expect(g.nodes).toHaveLength(6);
    expect(g.edges).toHaveLength(4);
    expect(g.byId.get("config_load")?.label).toBe("loadConfig()");
    // Incident is both directions — an impact query walks it backwards.
    expect(g.incident.get("config_load")).toHaveLength(3);
  });

  it("accepts `edges` as well as networkx's `links`", () => {
    const g = parseGraph(JSON.stringify({ nodes: FIXTURE.nodes, edges: FIXTURE.links }))!;
    expect(g.edges).toHaveLength(4);
  });

  it("returns undefined for junk rather than throwing", () => {
    expect(parseGraph("not json")).toBeUndefined();
  });

  it("skips malformed entries instead of rejecting the whole graph", () => {
    const g = parseGraph(JSON.stringify({ nodes: [{ id: "a", label: "a" }, { label: "no id" }], links: [{ source: "a" }] }))!;
    expect(g.nodes).toHaveLength(1);
    expect(g.edges).toHaveLength(0);
  });
});

describe("graph_impact — what a change can break", () => {
  it("walks INCOMING dependencies outward, nearest first", async () => {
    await seed();
    const r = await graphImpactTool.run({ symbol: "loadConfig", depth: 2 }, ctx());
    expect(r.isError).toBe(false);
    expect(r.content).toContain("cli.ts");
    expect(r.content).toContain("main()");
    // Two hops away: app.ts calls main() which calls loadConfig.
    expect(r.content).toContain("app.ts");
  });

  it("respects the depth limit", async () => {
    await seed();
    const r = await graphImpactTool.run({ symbol: "loadConfig", depth: 1 }, ctx());
    expect(r.content).toContain("main()");
    expect(r.content).not.toContain("app.ts");
  });

  // `contains` is structure, not dependency: a file holding a function says nothing about what a change to
  // that function reaches. Including it would report every sibling in the file as impacted.
  it("does not treat containment as a dependency", async () => {
    await seed();
    const r = await graphImpactTool.run({ symbol: "loadConfig" }, ctx());
    expect(r.content).not.toMatch(/←.*config\.ts.*contains/);
  });

  it("says plainly when nothing depends on it — and does not claim certainty", async () => {
    await seed();
    const r = await graphImpactTool.run({ symbol: "helper" }, ctx());
    expect(r.content).toMatch(/Nothing in the graph depends on it/);
    expect(r.content).toMatch(/dynamic dispatch/i);
  });

  // The graph only sees what a parser can see. An agent told "2 callers" without that caveat will believe it.
  it("always warns that the parser cannot see dynamic calls", async () => {
    await seed();
    const r = await graphImpactTool.run({ symbol: "loadConfig" }, ctx());
    expect(r.content).toMatch(/floor, not a ceiling/);
  });

  it("caps the answer and says it was capped", async () => {
    const many = {
      nodes: [{ id: "hub", label: "hub()" }, ...Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, label: `caller${i}()` }))],
      links: Array.from({ length: 200 }, (_, i) => ({ source: `c${i}`, target: "hub", relation: "calls" })),
    };
    await seed(many);
    const r = await graphImpactTool.run({ symbol: "hub" }, ctx());
    expect(r.content).toMatch(/stopped at 60/);
    expect(r.content.split("\n").length).toBeLessThan(MAX_ROWS + 15);
  });

  it("asks which one rather than guessing between equal matches", async () => {
    await seed({
      nodes: [
        { id: "a", label: "run()", source_file: "a.ts", source_location: "L1" },
        { id: "b", label: "run()", source_file: "b.ts", source_location: "L2" },
      ],
      links: [],
    });
    const r = await graphImpactTool.run({ symbol: "run" }, ctx());
    expect(r.content).toMatch(/matches 2 symbols/);
    expect(r.content).toContain("a.ts");
  });

  it("reports an unknown symbol instead of returning an empty answer", async () => {
    await seed();
    const r = await graphImpactTool.run({ symbol: "nonexistent" }, ctx());
    expect(r.content).toMatch(/Nothing in the graph matches/);
  });
});

describe("the other lookups", () => {
  it("graph_find gives path and line", async () => {
    await seed();
    const r = await graphFindTool.run({ symbol: "loadConfig" }, ctx());
    expect(r.content).toContain("src/config.ts:136");
  });

  it("graph_context separates what it uses from what uses it", async () => {
    await seed();
    const r = await graphContextTool.run({ symbol: "main" }, ctx());
    expect(r.content).toMatch(/Uses \(1\)/);
    expect(r.content).toMatch(/Used by \(1\)/);
  });

  it("graph_context filters by relation", async () => {
    await seed();
    const r = await graphContextTool.run({ symbol: "loadConfig", relation: "calls" }, ctx());
    expect(r.content).toContain("main()");
    // The `imports` and `contains` edges on the same node are excluded. Asserting on the relation, not on a
    // path: main()'s own path legitimately contains "cli.ts".
    expect(r.content).not.toMatch(/\bimports\b/);
    expect(r.content).not.toMatch(/\bcontains\b/);
  });

  it("graph_overview names the load-bearing symbols", async () => {
    await seed();
    const r = await graphOverviewTool.run({}, ctx());
    expect(r.content).toMatch(/6 symbols across \d+ files/);
    expect(r.content).toContain("loadConfig()");
  });
});

/**
 * The graph clusters the codebase on its own, but naming those clusters is the one step an LLM performs —
 * step 5 of graphify's runbook: "look at its node labels and write a 2-5 word plain-language name". The names
 * land in a SEPARATE file; `graph.json` keeps only the number.
 *
 * So an agent reading the graph alone sees "community 7" — which is not knowledge, it is an index. Measured on
 * a real project: 6283 communities, every one named, and not one of those names present in `graph.json`.
 */
describe("communities have names, and the tools use them", () => {
  const NAMED = {
    nodes: [
      { id: "config", label: "config.ts", source_file: "src/config.ts", source_location: "L1", community: 0 },
      { id: "config_load", label: "loadConfig()", source_file: "src/config.ts", source_location: "L136", community: 0 },
      { id: "cli", label: "cli.ts", source_file: "src/cli.ts", source_location: "L1", community: 1 },
      { id: "cli_main", label: "main()", source_file: "src/cli.ts", source_location: "L93", community: 1 },
      { id: "orphan", label: "orphan()", source_file: "src/o.ts", source_location: "L1" },
    ],
    links: [
      { source: "cli_main", target: "config_load", relation: "calls" },
      { source: "config", target: "config_load", relation: "contains" },
    ],
  };
  const LABELS = { "0": "Configuration Loading", "1": "Command Line Entry" };

  const seedNamed = async (labels: unknown = LABELS): Promise<void> => {
    await seed(NAMED);
    if (labels !== undefined) {
      await writeFile(join(cwd, "graphify-out", ".graphify_labels.json"), JSON.stringify(labels), "utf8");
    }
  };

  it("resolves a node's community number to the name a human wrote", async () => {
    await seedNamed();
    const r = await graphContextTool.run({ symbol: "loadConfig" }, ctx());
    expect(r.content).toContain("Configuration Loading");
    expect(r.content).not.toMatch(/community 0|\bcommunity\b\s*\d/i); // never the raw number
  });

  /**
   * The reason this is worth surfacing at all: a change that stays inside its own area is a different kind of
   * change from one that reaches into another. The number could never say that; the name can.
   */
  it("marks the reach that leaves the symbol's own area", async () => {
    await seedNamed();
    const r = await graphImpactTool.run({ symbol: "loadConfig" }, ctx());
    expect(r.content).toContain("Command Line Entry");   // main() is in a different area — said so
    expect(r.content).not.toMatch(/main\(\).*Configuration Loading/); // …and not mislabelled with its own
  });

  it("gives an unfamiliar reader the project's areas, largest first", async () => {
    await seedNamed();
    const r = await graphOverviewTool.run({}, ctx());
    expect(r.content).toContain("Configuration Loading");
    expect(r.content).toContain("Command Line Entry");
  });

  /** Two symbols with one name is exactly when "which one?" is answerable by area rather than by path alone. */
  it("tells apart same-named symbols by the area they live in", async () => {
    await seed({
      nodes: [
        { id: "a", label: "run()", source_file: "a.ts", source_location: "L1", community: 0 },
        { id: "b", label: "run()", source_file: "b.ts", source_location: "L2", community: 1 },
      ],
      links: [],
    });
    await writeFile(join(cwd, "graphify-out", ".graphify_labels.json"), JSON.stringify(LABELS), "utf8");
    const r = await graphImpactTool.run({ symbol: "run" }, ctx());
    expect(r.content).toContain("Configuration Loading");
    expect(r.content).toContain("Command Line Entry");
  });

  /**
   * Most projects have a graph and no names — the file is new, and older graphs predate it. Every tool must
   * answer exactly as it did before, with no empty brackets or dangling separators where a name would go.
   */
  it("reads exactly as before when the project has no names yet", async () => {
    await seed(NAMED);                                   // graph, no labels file
    const withoutNames = await graphContextTool.run({ symbol: "loadConfig" }, ctx());
    expect(withoutNames.isError).toBe(false);
    expect(withoutNames.content).toContain("src/config.ts:136");
    expect(withoutNames.content).not.toContain("·");     // no separator with nothing after it
    expect(withoutNames.content).not.toMatch(/\s\(\)/);   // no empty bracket where a name would have gone
  });

  it("survives a corrupt names file rather than losing the graph with it", async () => {
    await seed(NAMED);
    await writeFile(join(cwd, "graphify-out", ".graphify_labels.json"), "{ not json", "utf8");
    const r = await graphContextTool.run({ symbol: "loadConfig" }, ctx());
    expect(r.isError).toBe(false);
    expect(r.content).toContain("src/config.ts:136");
  });

  /**
   * graphify seeds every community with `'Community ' + str(cid)` before the naming step, and the naming step
   * replaces the ones it gets to. Measured on a real project: 6283 communities, 5057 of them still carrying
   * the seed — 80%. Passing those through would put "Community 4821" in front of an agent, which is the raw
   * number again, dressed as knowledge. An unnamed area must read as unnamed.
   */
  it("treats graphify's un-replaced placeholder as no name at all", async () => {
    await seedNamed({ "0": "Community 0", "1": "Command Line Entry" });
    const r = await graphContextTool.run({ symbol: "loadConfig" }, ctx());
    expect(r.content).not.toMatch(/Community\s*0/);
    const ov = await graphOverviewTool.run({}, ctx());
    expect(ov.content).toContain("Command Line Entry");   // the real one survives
    expect(ov.content).not.toMatch(/Community\s*0/);
  });

  /**
   * The count is the judgement; the names are the recognition. Naming every area a load-bearing interface
   * touches costs more than it adds, and the rows underneath already name them all — measured on a real
   * project, one interface reached 24 areas and printed all 24 on a single line.
   */
  it("says how far a change spreads without listing every area it reaches", async () => {
    const hub = {
      nodes: [
        { id: "hub", label: "hub()", source_file: "h.ts", source_location: "L1", community: 0 },
        ...Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, label: `caller${i}()`, source_file: `c${i}.ts`, source_location: "L1", community: i + 1 })),
      ],
      links: Array.from({ length: 20 }, (_, i) => ({ source: `c${i}`, target: "hub", relation: "calls" })),
    };
    await seed(hub);
    const names = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [String(i), `Area Number ${i}`]));
    await writeFile(join(cwd, "graphify-out", ".graphify_labels.json"), JSON.stringify(names), "utf8");

    const r = await graphImpactTool.run({ symbol: "hub", depth: 1 }, ctx());
    const line = r.content.split("\n").find((l) => l.startsWith("It reaches"))!;
    expect(line).toContain("20 area(s)");        // the size is stated exactly
    expect(line).toMatch(/and 14 more/);          // …and the naming stops
    expect(line.match(/`/g)!.length / 2).toBeLessThanOrEqual(7); // 6 areas + the home area
  });

  /** A node with no community at all (graphify leaves singletons unassigned) must not gain an invented area. */
  it("says nothing about a symbol that belongs to no area", async () => {
    await seedNamed();
    const r = await graphContextTool.run({ symbol: "orphan" }, ctx());
    expect(r.content).toContain("src/o.ts");
    expect(r.content).not.toContain("Configuration Loading");
  });

  /**
   * The graph is re-read on every call so a rebuild is visible immediately; the names are a second file, and
   * a cache keyed only on the first would serve yesterday's names after a re-label.
   */
  it("notices the names changing under a graph that did not", async () => {
    await seedNamed();
    expect((await graphContextTool.run({ symbol: "loadConfig" }, ctx())).content).toContain("Configuration Loading");
    await writeFile(join(cwd, "graphify-out", ".graphify_labels.json"),
      JSON.stringify({ "0": "Settings And Secrets", "1": "Command Line Entry" }), "utf8");
    expect((await graphContextTool.run({ symbol: "loadConfig" }, ctx())).content).toContain("Settings And Secrets");
  });
});

describe("no graph yet", () => {
  // An agent told "no graph" must not go off trying to build one — that is a user action.
  it.each([graphImpactTool, graphFindTool, graphContextTool, graphOverviewTool])("%s says so and points elsewhere", async (tool) => {
    const r = await tool.run({ symbol: "x" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/No code graph has been built/);
    expect(r.content).toMatch(/read_file\/grep/);
  });

  it("every graph tool is safe — a lookup must never interrupt the user for approval", () => {
    for (const t of [graphImpactTool, graphFindTool, graphContextTool, graphOverviewTool]) {
      expect(t.permissionLevel).toBe("safe");
    }
  });
});
