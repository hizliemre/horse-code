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
