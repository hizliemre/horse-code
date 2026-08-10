/**
 * What the session has to work with, in six lines.
 *
 * The launch banner used to print every standing rule in full. On a real project that was twenty-five rules
 * — a wall of prose filling the screen before the user had typed anything, and unreadable precisely because
 * it was complete. Rules are already inlined into every agent's prompt; reprinting them at the user costs a
 * screen and tells them nothing they can act on.
 *
 * What is worth saying at launch is whether the pieces are THERE: is there a constitution, how much memory,
 * how many skills, is the graph built and traced, which MCP servers answered. Each is a number or a yes/no,
 * and anything that is missing is the one thing worth reading.
 */

export interface StartupFacts {
  /** Standing rules in effect — the count only; the text of each is in `/memories`. */
  rules: number;
  /** Memory by kind. `total` is stated separately because entries of other kinds exist. */
  memory: { total: number; rules: number; lessons: number; facts: number };
  skills: number;
  /** Where traces live in THIS project, repo-relative — configurable, so it must not be spelled out twice. */
  traceRoot: string;
  constitution: boolean;
  graph: { built: boolean; nodes: number; stale?: boolean };
  /**
   * Traces on record — undefined until the index has been READ.
   *
   * Not `0`, because the two are different claims and the screen has to be able to make only the one that is
   * true. A default of zero rendered as "no per-file traces (`/graph trace` writes them)" over a project with
   * 2,500 of them, for as long as the graph rebuild in front of it took.
   */
  traces?: number;
  /**
   * Coverage, once it has been counted — undefined while the pass is still running.
   *
   * A bare trace count has no denominator, and a project with 2,445 traces and 226 files needing one reads
   * exactly like a project that is finished. Reported live: `/graph trace` queued 226 files and the start-up
   * screen had said nothing about any of them.
   */
  coverage?: { traceable: number; current: number; missing: number; stale: number };
  /** Connected servers, once they answer — undefined while still connecting. */
  mcp?: { name: string; tools: number }[];
  /**
   * Sessions left with work in them, newest first — one line each.
   *
   * The most actionable thing on the screen when it is not empty, and it was the one thing the screen never
   * said. See src/engine/unfinished.ts for the run whose 126 commits went unmentioned.
   */
  unfinished?: string[];
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const num = (n: number): string => n.toLocaleString("en-US");

/**
 * What the graph knows about the files, and what it does not.
 *
 * The gap is the point. A count on its own ("2,445 file traces") answers a question nobody asked, while what
 * a user can act on is how many files are NOT covered and how many describe code that has since changed —
 * the two states that make `/graph trace` do work. Both are named, because they are different problems: a
 * missing trace is a file no agent has been told about, a stale one is a file every agent is being told about
 * WRONGLY.
 */
function traceLine(f: StartupFacts): string {
  const c = f.coverage;
  // Nothing has been read yet: say that, and recommend nothing. See `traces` for what this cost.
  if (f.traces === undefined) return `reading file traces in \`${f.traceRoot}\`…`;
  if (!c || !c.traceable) {
    return f.traces
      ? `${plural(f.traces, "file trace")} in \`${f.traceRoot}\``
      : `no per-file traces (\`/graph trace\` writes them under \`${f.traceRoot}\`)`;
  }
  if (!c.current) return `no per-file traces for ${num(c.traceable)} files (\`/graph trace\` writes them under \`${f.traceRoot}\`)`;
  const behind = [
    c.missing ? `${num(c.missing)} untraced` : "",
    c.stale ? `${num(c.stale)} stale` : "",
  ].filter(Boolean).join(", ");
  return behind
    ? `${num(c.current)}/${num(c.traceable)} files traced in \`${f.traceRoot}\` — ${behind} (\`/graph trace\`)`
    : `all ${num(c.traceable)} files traced in \`${f.traceRoot}\``;
}

/**
 * The summary, as one note.
 *
 * Absences are stated, not omitted: "no constitution yet" is the line a user needs, while a silent gap reads
 * as everything being fine.
 */
export function startupSummary(f: StartupFacts): string {
  const m = f.memory;
  const kinds = [
    m.rules ? `${m.rules} rule${m.rules === 1 ? "" : "s"}` : "",
    m.lessons ? `${m.lessons} lesson${m.lessons === 1 ? "" : "s"}` : "",
    m.facts ? `${m.facts} fact${m.facts === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ");

  const graph = f.graph.built
    ? `${f.graph.nodes.toLocaleString("en-US")} nodes${f.graph.stale ? " (stale — `/graph build`)" : ""}`
    : "not built — `/graph build`";

  const lines = [
    `**Ready.**`,
    `- Constitution: ${f.constitution ? "in place" : "not established yet"}`,
    `- Rules: ${f.rules} active${f.rules ? " (`/memories` to read them)" : ""}`,
    `- Memory: ${plural(m.total, "entry", "entries")}${kinds ? ` — ${kinds}` : ""}`,
    `- Skills: ${plural(f.skills, "available", "available")}`,
    /**
     * "traces" is named precisely, because the word is taken.
     *
     * A real project keeps 58 architecture traces of its own under `docs/architecture/` and writes them by
     * hand ("docs(architecture): trace 52 — …"). Saying "no traces yet" there is true of horse-code's own
     * per-file traces and false of the project, which reads as the tool having missed what is plainly in the
     * repository. Naming the artefact and where it lives keeps the two apart.
     */
    `- Graph: ${graph} · ${traceLine(f)}`,
  ];
  /**
   * Above MCP, because it is the only line that is about THIS user's unfinished work.
   *
   * Everything else on the screen describes what the session has to work WITH; this describes what it was
   * doing. A person who stopped a run yesterday opens the terminal to find out where they were.
   */
  if (f.unfinished?.length) {
    lines.push(`- Unfinished: ${f.unfinished[0]}`);
    for (const more of f.unfinished.slice(1)) lines.push(`  · ${more}`);
  }
  // MCP is connected in the background, so the line appears only once there is something to say.
  if (f.mcp) {
    lines.push(`- MCP: ${f.mcp.length ? f.mcp.map((s) => `${s.name} (${s.tools} tools)`).join(", ") : "none connected"}`);
  }
  return lines.join("\n");
}
