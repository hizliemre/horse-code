import { z } from "zod";
import type { Tool } from "../core/types.js";
import type { ToolRegistry } from "./registry.js";

/**
 * Fetches the tools an agent decides it needs, instead of carrying all of them all the time.
 *
 * A tool's schema is re-sent on every turn of every agent that holds it, used or not. Measured across twelve
 * runs of a real project: the 49 MCP tool schemas came to 86,620 characters — ~21,655 tokens — and 242 model
 * calls carried them, which is ~5.2M of the 21.7M input tokens actually billed. In the same twelve runs those
 * 49 tools were called FIVE times, and only two of them were ever called at all. The gateway does not honour
 * prompt caching (measured: an identical 7,438-token prefix billed 5,438 tokens on four consecutive calls,
 * with and without `cache_control`), so every one of those tokens is paid in full, every turn.
 *
 * What is NOT deferred is the catalogue: the system prompt already lists each project tool on one line, in
 * 900 characters. Knowing what exists is cheap; knowing how to call it is what costs, and that is the part
 * this fetches on demand.
 */

const params = z.object({
  query: z.string().describe(
    "What you need a tool for, in a few words — e.g. \"pull request comments\", \"list angular projects\". "
    + "Or an exact tool name to fetch just that one."),
});

/** How many tools one search may open. Enough for a real choice; few enough that a vague query cannot undo this. */
export const MAX_FOUND = 5;

/**
 * Words too common in tool descriptions to tell two tools apart.
 *
 * `mcp` is in here because it is in every name: searching for `mcp__ng__list_projects` matched
 * `mcp__ado__wit_work_item` on the prefix alone and spent one of the five slots on it. A token that every
 * candidate shares carries no information and only crowds out the ones that do.
 */
const NOISE = new Set(["the", "a", "an", "of", "for", "in", "on", "to", "and", "or", "with", "by", "from",
  "get", "list", "tool", "project", "use", "this", "that", "it", "is", "are", "be", "mcp"]);

const words = (s: string): string[] =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !NOISE.has(w));

/** Name matches count for more than description matches: a name is what the caller meant, prose is context. */
export function scoreTool(t: Tool, query: string): number {
  const q = words(query);
  if (!q.length) return 0;
  const name = t.name.toLowerCase();
  const desc = t.description.toLowerCase();
  let score = 0;
  for (const w of q) {
    if (name.includes(w)) score += 3;
    else if (desc.includes(w)) score += 1;
  }
  // An exact name, however it was written, is not a guess.
  if (name === query.toLowerCase().trim()) score += 100;
  return score;
}

export function buildFindToolTool(registry: ToolRegistry): Tool {
  return {
    name: "find_tool",
    description:
      "Fetches the full definition of a project tool so you can call it. The system prompt lists the tools "
      + "this project connects, by name and one line each; their parameters are not loaded until you ask. "
      + "Pass what you need — \"pull request threads\", \"run a build pipeline\" — or an exact tool name. The "
      + "matches become callable from your NEXT message, so call this first, then call the tool itself. If a "
      + "search returns nothing useful, do the job with the tools you already have rather than searching again "
      + "with different words.",
    permissionLevel: "safe",
    parameters: params,
    run: async (rawArgs) => {
      const parsed = params.safeParse(rawArgs);
      if (!parsed.success) {
        return { content: `find_tool: invalid args: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
      }
      const { query } = parsed.data;
      /**
       * A tool that has already proven it cannot answer is not offered again.
       *
       * Without this the withdrawal only saves the round trip: each fresh agent still finds the tool, calls
       * it, and spends a turn being told it is broken. Measured on one run — twenty-odd such calls across
       * eight different roles, every one of them the same reply.
       */
      const pool = registry.deferredTools().filter((t) => t.broken === undefined);
      if (!pool.length) {
        return {
          content: "Every tool this project connects is already loaded — there is nothing further to fetch. "
            + "Use the ones you have.",
          isError: false,
        };
      }
      const scored = pool
        .map((t) => ({ t, s: scoreTool(t, query) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s);
      // An exact name is not a search: opening its neighbours would spend the saving on tools nobody asked for.
      const exact = scored.find((x) => x.t.name.toLowerCase() === query.toLowerCase().trim());
      const hits = exact ? [exact] : scored.slice(0, MAX_FOUND);
      if (!hits.length) {
        return {
          content: `No project tool matches "${query}". Available to fetch: `
            + `${pool.map((t) => t.name).join(", ")}.`,
          isError: false,
        };
      }
      registry.surface(hits.map((x) => x.t.name));
      const rows = hits.map((x) => `- \`${x.t.name}\` — ${x.t.description.replace(/^\[MCP:[^\]]*\]\s*/, "").split(/\n/)[0].trim()}`);
      return {
        content: `Loaded ${hits.length} tool(s) — you can call them from your next message:\n${rows.join("\n")}`,
        isError: false,
      };
    },
  };
}
