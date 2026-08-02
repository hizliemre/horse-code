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

/**
 * Pulls the choices out of a question that already lists them, without a model.
 *
 * An agent that embeds its options in a markdown table has already done the structuring work; asking a model
 * to redo it adds a call, a delay and a failure mode to something that can simply be read. And that failure
 * mode was silent: when the normalizer threw or returned nothing, the question fell through as free text and
 * nobody could tell whether it had run.
 *
 * Deterministic, so it either finds the options or plainly does not.
 */
export interface ExtractedChoices {
  choices: { label: string; description?: string }[];
  /** The question with the consumed list removed — showing it twice makes the reader check whether it differs. */
  question: string;
}

/** The choices only, for callers that do not need the trimmed question. */
export function extractChoices(text: string): { label: string; description?: string }[] {
  return extractChoicesFrom(text).choices;
}

export function extractChoicesFrom(text: string): ExtractedChoices {
  const lines = text.split("\n");

  // A markdown table: rows are `| A | what it means |`. The header and separator are not choices.
  const rows = lines
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|") && l.endsWith("|") && !/^\|[\s|:-]+\|$/.test(l))
    .map((l) => l.slice(1, -1).split("|").map((c) => c.trim()));
  const body = rows.filter((cells) => cells.length >= 2 && cells[0] && cells[1])
    // The first row is a header when its cells name the columns rather than being a choice.
    .filter((cells, i) => !(i === 0 && /^(option|seçenek|choice|alternatif)$/i.test(cells[0])));
  if (body.length >= 2) {
    // Drop every table line, not only the rows kept: the header and separator are part of the same table.
    const question = lines.filter((l) => !/^\s*\|.*\|\s*$/.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return { choices: body.map((cells) => ({ label: cells[0], description: cells.slice(1).join(" — ") })), question };
  }

  // A lettered list: `A) …` / `B. …`, one per line.
  const isLettered = (l: string): RegExpExecArray | null => /^\s*([A-Ea-e])[).\-:]\s+(\S.*)$/.exec(l.trim());
  const lettered = lines.map(isLettered).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ label: `${m[1].toUpperCase()} — ${m[2]}` }));
  if (lettered.length >= 2) {
    const question = lines.filter((l) => !isLettered(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return { choices: lettered, question };
  }

  /**
   * …and the same list written INLINE, inside a paragraph: `… Options: (A) … (B) … (C) …`.
   *
   * Measured on a real clarify question: `looksLikeChoices` said yes, the extractor found nothing, and the
   * user was handed a nine-line wall of prose with three options buried in it and no list to choose from.
   * The line-anchored form was the only one it knew, and a model writing a question in flowing text does
   * not use it.
   *
   * Split on the MARKERS rather than on sentences: the option bodies contain full stops, commas and their
   * own parentheses, and any attempt to find their edges by punctuation cuts them in the wrong places.
   */
  const MARKER = /\(([A-Ea-e])\)\s*/g;
  const marks = [...text.matchAll(MARKER)];
  // Must run A, B, C… in order and start at A — otherwise this is prose that happens to contain "(a)".
  const inOrder = marks.length >= 2
    && marks.every((m, i) => m[1].toUpperCase() === String.fromCharCode(65 + i));
  if (inOrder) {
    const first = marks[0].index ?? 0;
    const parts = marks.map((m, i) => {
      const start = (m.index ?? 0) + m[0].length;
      const end = i + 1 < marks.length ? marks[i + 1].index ?? text.length : text.length;
      return { letter: m[1].toUpperCase(), body: text.slice(start, end).trim().replace(/\s+/g, " ") };
    }).filter((p) => p.body);
    if (parts.length >= 2) {
      // The lead-in that introduced them ("Options:", "Seçenekler:") goes with the list, not the question.
      const question = text.slice(0, first).replace(/\s*(Se\u00e7enekler|Options|Choices)\s*:?\s*$/i, "").trim();
      return {
        choices: parts.map((p) => ({ label: `${p.letter} — ${clipLabel(p.body)}`, description: p.body })),
        question: question || text,
      };
    }
  }

  return { choices: [], question: text };
}

/** A label is one line in a list; the full text stays in the description beside it. */
const clipLabel = (body: string): string => {
  const cut = body.replace(/^\[[^\]]*\]\s*/, ""); // a leading tag like "[RECOMMENDED]" is not the label
  const stop = cut.search(/[—–.;:]\s/);
  const head = stop > 12 ? cut.slice(0, stop) : cut;
  return head.length > 72 ? `${head.slice(0, 71)}…` : head;
};
