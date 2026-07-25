import { z } from "zod";
import type { Tool } from "../core/types.js";

const params = z.object({
  text: z.string(),
  kind: z.enum(["fact", "lesson"]).optional(),
});

/**
 * Proposes a durable project fact/lesson. Unlike `remember_fact` this does NOT write anything: it hands a raw
 * signal to the memory curator, which rewrites, merges or discards it at the end of the job.
 *
 * Given to review agents (lenses, council, judge, reviewers). They read more of the project than anyone else,
 * but they are narrow single-angle finders on cheaper model tiers — exactly the agents whose unsupervised
 * writes would poison the store. The description is deliberately restrictive: the failure mode to design
 * against is a lens logging its current finding as if it were a lasting truth about the project.
 */
export const proposeMemoryTool: Tool = {
  name: "propose_memory",
  description:
    "Propose something you learned about THIS PROJECT for long-term memory. It is NOT stored directly — a " +
    "curator reviews, rewrites and may discard it. Propose ONLY durable, project-specific knowledge that " +
    "would still be true and useful months from now in an unrelated task: a convention, a constraint, a " +
    "non-obvious gotcha, the root cause of a recurring problem. NEVER propose your findings about the work " +
    "you are reviewing right now, anything about this specific task or run, or general programming advice. " +
    "Most reviews should propose nothing at all. Use it at most once, and only when you are sure.",
  permissionLevel: "safe",
  parameters: params,
  async run(rawArgs, ctx) {
    const parsed = params.safeParse(rawArgs);
    if (!parsed.success) return { content: "propose_memory: invalid args (expected { text, kind? })", isError: true };
    const text = parsed.data.text.trim();
    if (!text) return { content: "propose_memory: empty proposal", isError: true };
    if (!ctx.proposeMemory) return { content: "propose_memory: memory is not available in this context", isError: true };
    const accepted = ctx.proposeMemory(text, parsed.data.kind ?? "fact");
    return {
      content: accepted
        ? "Proposal queued for the memory curator. It may be rewritten or discarded; do not propose it again."
        : "Already proposed (or the queue is full) — no action needed.",
      isError: false,
    };
  },
};
