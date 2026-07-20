import { z } from "zod";
import type { RoleAgentOptions } from "../agent/loop.js";
import type { Board } from "../board/board.js";
import { runStructuredRole } from "../agent/structured.js";
import { computeWaves, validateWaves } from "./waves.js";

export const WavesSchema = z.object({ waves: z.array(z.array(z.string())) });

/**
 * Deterministik dalgaları hesaplar, team-lead LLM'iyle teyit eder.
 * LLM çıktısı geçerliyse onu, değilse (veya hata/submit yoksa) deterministik tabanı döner.
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
      `Kartlar:\n${cardsDesc}\n\nDeterministik önerilen dalgalar (id listeleri):\n` +
      `${JSON.stringify(suggested)}\n\nBu dalgaları teyit et; gerekiyorsa düzelt. ` +
      `Her task tam bir kez olmalı ve her dalgadaki task'ın bağımlılıkları önceki dalgalarda tamamlanmış olmalı.`,
  };

  let llmWaves: string[][];
  try {
    const out = await runStructuredRole(
      { ...opts, messages: [...opts.messages, teamLeadMsg] },
      WavesSchema,
    );
    llmWaves = out.waves;
  } catch {
    return suggested; // LLM submit üretmedi / hata → deterministik
  }

  return validateWaves(llmWaves, board) ? llmWaves : suggested;
}
