import { z } from "zod";
import type { Tool } from "../core/types.js";

const params = z.object({ fact: z.string() });

/**
 * Persists a durable fact the model learned (often from a tool result — e.g. "tests live in /spec") to
 * cross-session memory. Safe (read-only w.r.t. the repo); no-op when no memory sink is wired.
 */
export const rememberFactTool: Tool = {
  name: "remember_fact",
  description:
    "Save a short, durable fact worth recalling in future sessions (e.g. a project convention, a file " +
    "location, or a stated preference). Use sparingly — only for facts, not transient details.",
  permissionLevel: "safe",
  parameters: params,
  async run(rawArgs, ctx) {
    const parsed = params.safeParse(rawArgs);
    if (!parsed.success) return { content: "remember_fact: invalid args (expected { fact })", isError: true };
    const fact = parsed.data.fact.trim();
    if (!fact) return { content: "remember_fact: empty fact", isError: true };
    if (!ctx.remember) return { content: "remember_fact: memory is not available in this context", isError: true };
    ctx.remember(fact);
    return { content: `Remembered: ${fact}`, isError: false };
  },
};
