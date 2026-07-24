import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import { ToolRegistry } from "../tools/registry.js";
import type { TaskCycleDeps } from "./task-types.js";

export interface NormalizedQuestion { question: string; options: string[]; multiSelect: boolean }

export const NormalizedQuestionSchema = z.object({
  question: z.string().describe("The core question, concise, WITHOUT the embedded options table/list."),
  options: z.array(z.string()).describe("Each selectable choice as a SHORT label; the recommended one first, suffixed ' (recommended)'. Empty when the question is genuinely open-ended."),
  multiSelect: z.boolean().describe("true only if the user may pick more than one."),
});

const PROMPT =
  "You reformat an agent's question for a terminal UI that renders selectable options (arrow keys + Enter). " +
  "Given the raw question text — which may embed choices as a markdown table, an A/B/C/D list, or a " +
  "'recommended' suggestion — extract exactly:\n" +
  "- `question`: the core question, concise, WITHOUT the embedded options table/list.\n" +
  "- `options`: each selectable choice as a SHORT label. If one choice is recommended, list it FIRST and " +
  "append ' (recommended)'. Do NOT add an 'other' / free-text / 'answer in your own words' option — the UI " +
  "already provides that.\n" +
  "- `multiSelect`: true only if the user may pick several.\n" +
  "If the text is genuinely open-ended (no discrete choices), return options: []. Preserve the user's language. " +
  "Return the result via submit.";

/** Cheap gate: does the raw question look like it embeds discrete choices? (Avoids an LLM call for plain questions.) */
export function looksLikeChoices(text: string): boolean {
  return /\|[^\n]*\|[^\n]*\|/.test(text) // a markdown table row
    || /(^|\n)\s*[A-Ea-e][).\-:]\s/.test(text) // A) / B. / C - lettered list
    || /(^|\n)\s*[-*]\s+\S.*(\n\s*[-*]\s+\S.*){1,}/.test(text) // a bullet list of 2+ items
    || /\b(option|seçenek|choice|önerilen|recommended)\b/i.test(text);
}

/**
 * Turns a free-form question (whose author may have embedded the choices in prose) into a structured
 * {question, options, multiSelect} via a fast model, so the UI can render a real selectable list. Best-effort:
 * callers fall back to the raw question if this throws.
 */
export async function normalizeQuestion(deps: TaskCycleDeps, raw: string): Promise<NormalizedQuestion> {
  const { model, fallbacks, onExhausted, onFallback } = deps.roleRegistry.fallbackOpts("refiner");
  return runStructuredRole({
    provider: deps.provider, model, fallbacks, onExhausted, onFallback,
    systemPrompt: PROMPT,
    tools: new ToolRegistry(),
    messages: [{ role: "user", content: raw }],
    permission: deps.permission, approve: deps.approve, cwd: ".", signal: deps.signal,
  }, NormalizedQuestionSchema);
}
