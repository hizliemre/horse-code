import { z } from "zod";
import type { RoleAgentOptions } from "../agent/loop.js";
import type { Board } from "../board/board.js";
import { runStructuredRole } from "../agent/structured.js";
import { computeWaves, validateWaves } from "./waves.js";

export const WavesSchema = z.object({ waves: z.array(z.array(z.string())) });

/**
 * Computes deterministic waves, then confirms them with the team-lead LLM.
 * Returns the LLM output if valid; otherwise (or on error/no submit) returns the deterministic baseline.
 */
export async function runTeamLead(opts: RoleAgentOptions, board: Board): Promise<string[][]> {
  const suggested = computeWaves(board);

  const cardsDesc = board
    .list()
    .map((c) => `- ${c.id}: "${c.title}" deps=[${c.deps.join(", ")}]`)
    .join("\n");
  const teamLeadMsg = {
    role: "user" as const,
    content:
      `Cards:\n${cardsDesc}\n\nDeterministically suggested waves (id lists):\n` +
      `${JSON.stringify(suggested)}\n\nConfirm these waves; fix them if needed. ` +
      `Each task must appear exactly once, and each task's dependencies in a wave must be completed in earlier waves.`,
  };

  let llmWaves: string[][];
  try {
    const out = await runStructuredRole(
      { ...opts, messages: [...opts.messages, teamLeadMsg] },
      WavesSchema,
    );
    llmWaves = out.waves;
  } catch (e) {
    if (opts.signal.aborted) throw e; // abort → don't silently fall back, rethrow
    return suggested; // LLM didn't produce a submit / other error → deterministic baseline
  }

  return validateWaves(llmWaves, board) ? llmWaves : suggested;
}
