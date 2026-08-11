import { z } from "zod";
import type { Tool } from "../core/types.js";
import { loadGraphSync, areaOf } from "../engine/project-graph.js";
import { readTraceSync, everTraceable } from "../engine/trace.js";
import { readBriefSync } from "../engine/project-brief.js";
import type { ProjectGraph, GraphNode, GraphEdge } from "../engine/project-graph.js";

/**
 * Read-only lookups over the project's code graph.
 *
 * These exist to answer the question grep cannot: not "where does this name appear" but "what depends on
 * this, and what breaks if I change it". An agent fixing a bug in unfamiliar code needs that before it edits,
 * and a reviewer needs it to judge whether a change is contained.
 *
 * Every result is line-referenced and budgeted. The budget is not politeness: an unbounded graph walk on a
 * real codebase returns thousands of nodes, and the whole point is to spend FEWER tokens understanding the
 * project than reading it.
 */

/** Hard cap on rows in any one answer. Past this the answer stops being read and starts being skimmed. */
export const MAX_ROWS = 60;

const NO_GRAPH =
  "No code graph has been built for this project yet. It is built with `/graph build` and is not something " +
  "you can create — continue with read_file/grep instead.";

function where(n: GraphNode): string {
  return n.source_file ? `${n.source_file}${n.source_location ? `:${n.source_location.replace(/^L/, "")}` : ""}` : "";
}

/**
 * Where a symbol sits in the project, as a name.
 *
 * The graph clusters the codebase by itself, but it stores each node's community as a NUMBER — and a number
 * is an index, not knowledge. The names come from a separate file an LLM wrote once (see `LABELS_FILE`), and
 * turning "community 47" into "Wallet Member & Balance" is the entire value of reading it.
 *
 * Empty when the project has no names, or the symbol belongs to no community. Nothing is invented to fill the
 * gap: a bracket with nothing in it costs a reader more than the missing name does.
 */
function area(g: ProjectGraph, n: GraphNode | undefined): string {
  const name = areaOf(g, n);
  return name ? ` · ${name}` : "";
}

/** Nodes whose label or id matches, best-first: exact label, then prefix, then substring. */
function find(g: ProjectGraph, term: string): GraphNode[] {
  const t = term.toLowerCase().replace(/\(\)$/, "");
  const score = (n: GraphNode): number => {
    const l = n.label.toLowerCase().replace(/\(\)$/, "");
    if (l === t || n.id.toLowerCase() === t) return 0;
    if (l.startsWith(t)) return 1;
    if (l.includes(t) || n.id.toLowerCase().includes(t)) return 2;
    return 99;
  };
  return g.nodes.map((n) => [score(n), n] as const).filter(([s]) => s < 99)
    .sort((a, b) => a[0] - b[0]).map(([, n]) => n);
}

/** Two symbols with the same name is exactly when the area is the thing that tells them apart. */
function ambiguous(g: ProjectGraph, matches: GraphNode[], term: string): string {
  const rows = matches.slice(0, 12).map((n) => `- ${n.label} — ${where(n)}${area(g, n)}`);
  return `"${term}" matches ${matches.length} symbols. Name one exactly:\n${rows.join("\n")}`;
}

/** Resolves a search term to one node, or returns the text explaining why it could not. */
function resolve(g: ProjectGraph, term: string): { node: GraphNode } | { error: string } {
  const matches = find(g, term);
  if (!matches.length) return { error: `Nothing in the graph matches "${term}". It may be an external symbol, or the graph may predate it.` };
  // An exact hit wins outright; several equally-good fuzzy hits are a question, not a guess.
  const best = matches.filter((n) => n.label.toLowerCase().replace(/\(\)$/, "") === term.toLowerCase().replace(/\(\)$/, ""));
  if (best.length === 1) return { node: best[0] };
  if (matches.length === 1) return { node: matches[0] };
  if (best.length > 1) return { error: ambiguous(g, best, term) };
  return { error: ambiguous(g, matches, term) };
}

/** The other end of an edge, from a node's point of view. */
function other(e: GraphEdge, id: string): string {
  return e.source === id ? e.target : e.source;
}

const graphTool = (
  name: string,
  description: string,
  parameters: z.ZodType,
  body: (g: ProjectGraph, args: Record<string, unknown>) => string,
): Tool => ({
  name,
  description,
  permissionLevel: "safe",
  parameters,
  describe: (args) => ({ allowKey: `graph:${name}`, preview: `${name} ${JSON.stringify(args)}`.slice(0, 120) }),
  async run(args, ctx) {
    const g = loadGraphSync(ctx.cwd);
    if (!g) return { content: NO_GRAPH, isError: true };
    try {
      return { content: body(g, args as Record<string, unknown>), isError: false };
    } catch (e) {
      return { content: `${name}: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
  },
});

/**
 * The headline query: what a change to this symbol can reach.
 *
 * Walks INCOMING dependency edges — callers, importers, subclasses — because that is the direction damage
 * travels. What a function calls is its own business; what calls IT is what a change to it can break.
 */
export const graphImpactTool = graphTool(
  "graph_impact",
  "Blast radius: what depends on a function, class or file, and would be affected if you change it. " +
  "Use this BEFORE editing unfamiliar code. Walks callers/importers/subclasses outward, nearest first.",
  z.object({
    symbol: z.string().describe("Function, class or file name, e.g. \"parseConfig\" or \"config.ts\""),
    depth: z.number().int().min(1).max(4).optional().describe("How many hops outward (default 2)"),
  }),
  (g, args) => {
    const r = resolve(g, String(args.symbol));
    if ("error" in r) return r.error;
    const depth = Math.min(4, Math.max(1, Number(args.depth ?? 2)));
    // Only the relations along which a change propagates. `contains` is structure, not dependency: a file
    // containing a function tells you nothing about what a change to that function reaches.
    const DEPENDS = /^(calls|imports|imports_from|inherits|implements|references|method|re_exports)$/;

    const seen = new Set([r.node.id]);
    const levels: { hop: number; node: GraphNode; via: string; from: string }[] = [];
    let frontier = [r.node.id];
    for (let hop = 1; hop <= depth && levels.length < MAX_ROWS; hop++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of g.incident.get(id) ?? []) {
          if (!DEPENDS.test(e.relation)) continue;
          // Incoming only: something else depends on `id`.
          if (e.target !== id) continue;
          const src = e.source;
          if (seen.has(src)) continue;
          const node = g.byId.get(src);
          if (!node) continue;
          seen.add(src);
          next.push(src);
          levels.push({ hop, node, via: e.relation, from: g.byId.get(id)?.label ?? id });
          if (levels.length >= MAX_ROWS) break;
        }
        if (levels.length >= MAX_ROWS) break;
      }
      frontier = next;
      if (!frontier.length) break;
    }

    const head = `${r.node.label} — ${where(r.node)}${area(g, r.node)}`;
    if (!levels.length) {
      return `${head}\n\nNothing in the graph depends on it. A change here is contained — but the graph only ` +
        `covers what its parsers understand, so check for dynamic dispatch, string-keyed lookups and callers ` +
        `outside this repository.`;
    }
    /**
     * The area is named only where it DIFFERS from the symbol's own.
     *
     * A change that stays inside one area and a change that reaches into three are different sizes of change,
     * and that is the judgement this tool exists to inform. Repeating the origin's own name on every row would
     * bury the rows where it changes — which are the ones worth reading.
     */
    const home = areaOf(g, r.node);
    const rows = levels.map((l) => {
      const there = areaOf(g, l.node);
      const crossed = there && there !== home ? ` · ${there}` : "";
      return `${"  ".repeat(l.hop - 1)}← ${l.node.label} ${l.via} ${l.from} — ${where(l.node)}${crossed}`;
    });
    const others = [...new Set(levels.map((l) => areaOf(g, l.node)).filter((a): a is string => !!a && a !== home))];
    // The COUNT is the judgement — "this leaves its area 24 times over" — and naming all 24 costs more than
    // it adds. Enough names to recognise the direction, then the number for the size. Measured on a real
    // project: an uncapped line listed 24 areas for one interface, and the rows below already name them all.
    const NAMED_SPREAD = 6;
    const spread = others.length
      ? `\n\nIt reaches ${others.length} area(s) beyond ${home ? `\`${home}\`` : "its own"}: `
        + `${others.slice(0, NAMED_SPREAD).map((a) => `\`${a}\``).join(", ")}`
        + `${others.length > NAMED_SPREAD ? `, and ${others.length - NAMED_SPREAD} more` : ""}.`
      : "";
    const capped = levels.length >= MAX_ROWS ? `\n\n(stopped at ${MAX_ROWS} — the true blast radius is larger; narrow with a lower depth)` : "";
    return `Changing ${head} can affect ${levels.length} symbol(s), nearest first:\n\n${rows.join("\n")}${spread}${capped}\n\n` +
      `Dynamic calls and reflection are invisible to the parser — this is a floor, not a ceiling.`;
  },
);

/** Where something lives, without opening files to look for it. */
export const graphFindTool = graphTool(
  "graph_find",
  "Locate a function, class or file in the project and get its exact path and line. Faster and more precise " +
  "than grep for finding a definition.",
  z.object({ symbol: z.string().describe("Name to look for; partial names are matched") }),
  (g, args) => {
    const term = String(args.symbol);
    const matches = find(g, term);
    if (!matches.length) return `Nothing in the graph matches "${term}".`;
    const rows = matches.slice(0, MAX_ROWS).map((n) => `- ${n.label} — ${where(n)}${area(g, n)}`);
    const more = matches.length > MAX_ROWS ? `\n(+${matches.length - MAX_ROWS} more)` : "";
    return `${matches.length} match(es) for "${term}":\n${rows.join("\n")}${more}`;
  },
);

/** The immediate neighbourhood, in both directions — how a symbol sits in the codebase. */
export const graphContextTool = graphTool(
  "graph_context",
  "What a symbol uses and what uses it, one hop in each direction. Use it to understand unfamiliar code " +
  "before reading it.",
  z.object({
    symbol: z.string(),
    relation: z.string().optional().describe("Optional filter, e.g. \"calls\" or \"imports\""),
  }),
  (g, args) => {
    const r = resolve(g, String(args.symbol));
    if ("error" in r) return r.error;
    const filter = args.relation ? String(args.relation) : undefined;
    const edges = (g.incident.get(r.node.id) ?? []).filter((e) => !filter || e.relation === filter);
    const out = edges.filter((e) => e.source === r.node.id);
    const inc = edges.filter((e) => e.target === r.node.id);
    const render = (es: GraphEdge[], arrow: string): string[] =>
      es.slice(0, MAX_ROWS / 2).map((e) => {
        const n = g.byId.get(other(e, r.node.id));
        return `  ${arrow} ${e.relation} ${n?.label ?? other(e, r.node.id)}${n ? ` — ${where(n)}${area(g, n)}` : ""}`;
      });
    const body = [
      `${r.node.label} — ${where(r.node)}${area(g, r.node)}`,
      out.length ? `\nUses (${out.length}):\n${render(out, "→").join("\n")}` : "\nUses: nothing tracked.",
      inc.length ? `\nUsed by (${inc.length}):\n${render(inc, "←").join("\n")}` : "\nUsed by: nothing tracked.",
    ];
    return body.join("\n");
  },
);

/** The shape of the project: what the load-bearing pieces are. */
export const graphOverviewTool = graphTool(
  "graph_overview",
  "The project's shape: size, and the most-connected symbols — the load-bearing abstractions. Use it when " +
  "entering an unfamiliar codebase, before planning work in it.",
  z.object({ top: z.number().int().min(1).max(40).optional().describe("How many core symbols (default 15)") }),
  (g, args) => {
    const top = Math.min(40, Math.max(1, Number(args.top ?? 15)));
    const degree = new Map<string, number>();
    for (const [id, es] of g.incident) degree.set(id, es.length);
    const core = [...degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
      .map(([id, d]) => { const n = g.byId.get(id); return n ? `- ${n.label} (${d} connections) — ${where(n)}` : ""; })
      .filter(Boolean);
    const files = new Set(g.nodes.map((n) => n.source_file).filter(Boolean)).size;
    const rel = new Map<string, number>();
    for (const e of g.edges) rel.set(e.relation, (rel.get(e.relation) ?? 0) + 1);
    const relRow = [...rel.entries()].sort((a, b) => b[1] - a[1]).map(([r, c]) => `${r} ${c}`).join(" · ");

    /**
     * What the project is MADE OF, in its own words.
     *
     * The most-connected list answers "what is load-bearing" and it is the right first question, but it
     * answers it in symbols. Someone entering an unfamiliar codebase also needs the map — and the names are
     * the only part of the graph written in the product's vocabulary rather than the code's.
     */
    const size = new Map<number, number>();
    for (const n of g.nodes) if (n.community !== undefined) size.set(n.community, (size.get(n.community) ?? 0) + 1);
    const named = [...size.entries()]
      .map(([id, count]) => ({ name: g.areas.get(id), count }))
      .filter((a): a is { name: string; count: number } => !!a.name)
      .sort((a, b) => b.count - a.count);
    const shown = named.slice(0, top);
    const rest = named.length - shown.length;
    const areas = shown.length
      ? `\n\nAreas — what the project is made of, largest first:\n`
        + shown.map((a) => `- ${a.name} (${a.count} symbols)`).join("\n")
        + (rest > 0 ? `\n(+${rest} smaller area(s))` : "")
      : "";

    return `${g.nodes.length} symbols across ${files} files, ${g.edges.length} relationships (${relRow}).${areas}\n\n` +
      `Most connected — changing these reaches the most:\n${core.join("\n")}`;
  },
);

/**
 * What a file is FOR, in the product's terms — written by the trace stage, which the graph cannot produce.
 *
 * Separate from `read_file` on purpose: this is ~150 words of intent, where reading the file is thousands of
 * tokens of implementation. An agent orienting itself should reach for this first.
 */
export const graphTraceTool: Tool = {
  name: "graph_trace",
  description:
    "What a source file is responsible for and what to be careful of when changing it, in the product's " +
    "terms. Far cheaper than reading the file. Use it to orient before opening unfamiliar code. " +
    "Pass \"project\" instead of a path to get the project brief: what the product is, its domain vocabulary, " +
    "and the business rules the code must not violate. Read that FIRST in an unfamiliar codebase.",
  permissionLevel: "safe",
  parameters: z.object({ file: z.string().describe("Repo-relative path, e.g. \"src/config/config.ts\"") }),
  describe: (args) => ({ allowKey: "graph:trace", preview: `graph_trace ${JSON.stringify(args)}`.slice(0, 120) }),
  async run(args, ctx) {
    const file = String((args as { file?: unknown }).file ?? "");
    // The project brief is what this file is answerable AGAINST: without the domain vocabulary a per-file
    // note reads as mechanics. It is small and it is the same for every file, so it rides along.
    if (/^(project|_project|\.)$/i.test(file)) {
      const brief = readBriefSync(ctx.cwd);
      return brief
        ? { content: brief, isError: false }
        : { content: "No project brief yet — it is written by `/graph trace`, a user action.", isError: true };
    }
    const body = readTraceSync(ctx.cwd, file);
    if (body) return { content: body, isError: false };
    /**
     * "Not yet" and "never" are different answers, and only one of them invites a retry.
     *
     * A template, a stylesheet or a config file is not a kind of file the tracer visits, so telling its
     * asker that a trace might appear later sends them to `graph_find` and back for something that cannot
     * change. Measured on an Angular project, where the component's markup lives in `.html`: fifteen roles
     * asked about the same template and every one of them was told to keep looking.
     */
    if (!everTraceable(file)) {
      return {
        content: `No trace for "${file}", and there never will be: traces cover source code (.ts, .cs, .py, `
          + `.go, …), not templates, stylesheets or markup. Read the file directly — asking again, or looking `
          + `for another path with graph_find, will not turn one up.`,
        isError: true,
      };
    }
    return {
      content: `No trace for "${file}". Either it has none yet (traces are written by \`/graph trace\`, a user ` +
        `action) or the path differs — check it with graph_find. Read the file directly instead.`,
      isError: true,
    };
  },
};

/** Every graph tool, in the order an agent would naturally reach for them. */
export const GRAPH_TOOLS: Tool[] = [graphOverviewTool, graphTraceTool, graphFindTool, graphContextTool, graphImpactTool];
