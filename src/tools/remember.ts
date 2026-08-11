import { z } from "zod";
import type { Tool } from "../core/types.js";

const params = z.object({
  fact: z.string().describe(
    "One short sentence, durable and project-specific: where something lives, which command builds it, a "
    + "convention this codebase follows, a schema detail that cost you a search. Not what you did, not what "
    + "is true of the language in general — something the next agent would otherwise have to rediscover."),
});

/**
 * Persists a durable fact the model learned, immediately.
 *
 * WHO gets this matters more than what it does. It used to be the coach alone: a tester spent 110 tool calls
 * working out which interceptor fills `CreatedAt`, how `company_id` is applied, and which columns exist —
 * then the run ended and the next one started from nothing and did it again. The reviewers had
 * `propose_memory`, which queues for a curator that runs when the job finishes; a session stopped halfway —
 * and a long verification usually is — carries none of it.
 *
 * So this writes THROUGH, on the call, and every agent doing substantive work has it. The store already
 * dedupes and ages what it holds; what it could not do was learn from an agent that had no way to tell it.
 */
export function buildRememberTool(sink?: (fact: string) => void): Tool {
  return {
    name: "remember_fact",
    description:
      "Save a short, durable fact worth recalling in future sessions — a project convention, where something "
      + "lives, a schema detail, a command that works. It is written straight away, so a session that stops "
      + "early still leaves it behind. Use it the moment you learn something you would not want to work out "
      + "twice; skip anything transient or specific to the task in hand.",
    permissionLevel: "safe",
    parameters: params,
    async run(rawArgs, ctx) {
      const parsed = params.safeParse(rawArgs);
      if (!parsed.success) return { content: "remember_fact: invalid args (expected { fact })", isError: true };
      const fact = parsed.data.fact.trim();
      if (!fact) return { content: "remember_fact: empty fact", isError: true };
      const write = sink ?? ctx.remember;
      if (!write) return { content: "remember_fact: memory is not available in this context", isError: true };
      write(fact);
      return { content: `Remembered: ${fact}`, isError: false };
    },
  };
}

/** The context-wired form, for callers that pass the sink through `RoleAgentOptions.remember`. */
export const rememberFactTool: Tool = buildRememberTool();
