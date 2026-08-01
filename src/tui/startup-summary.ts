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
  traces: number;
  /** Connected servers, once they answer — undefined while still connecting. */
  mcp?: { name: string; tools: number }[];
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

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
    `- Graph: ${graph} · ${f.traces
      ? `${plural(f.traces, "file trace")} in \`${f.traceRoot}\``
      : `no per-file traces (\`/graph trace\` writes them under \`${f.traceRoot}\`)`}`,
  ];
  // MCP is connected in the background, so the line appears only once there is something to say.
  if (f.mcp) {
    lines.push(`- MCP: ${f.mcp.length ? f.mcp.map((s) => `${s.name} (${s.tools} tools)`).join(", ") : "none connected"}`);
  }
  return lines.join("\n");
}
