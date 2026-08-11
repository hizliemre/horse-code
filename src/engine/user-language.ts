import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ReviewDeps } from "./review.js";

/**
 * Text horse-code says in its OWN voice, put into the language the user is working in.
 *
 * Every other sentence the user reads was written by an agent that had been told which language to use —
 * `respondIn` does that, and the checkpoint records the language precisely so a resumed run can keep doing it.
 * A question asked by the ENGINE has no agent behind it, so it had no way to obey that rule: measured live, a
 * run driven entirely in Turkish was asked "Which branch is this project's main one?" in English, which is the
 * same defect `respondIn` was written for, arriving through the one door it does not cover.
 *
 * A translation table is not the answer — the language is whatever the user speaks, not one of a list we
 * chose. The cheap model tier already used to shape questions for this UI (see normalize-question.ts) is.
 *
 * Best-effort and cheap: on any failure the original English is asked, which is worse than the translation and
 * far better than no question at all. The one caller so far asks its question at most once per project.
 */

const Translated = z.object({
  text: z.string().describe("The same text, in the requested language. No commentary, no quotes."),
});

const PROMPT =
  "You translate one short piece of interface text for a terminal tool. Return the SAME text in the language "
  + "you are given: same meaning, same tone, same length, nothing added and nothing explained. Leave branch "
  + "names, file paths, commands and other identifiers exactly as they are — they are not words, they are "
  + "names. Return the result via submit.";

/** Whether a recorded language means "leave it alone". */
export function isEnglish(language?: string): boolean {
  return !language?.trim() || /^english$/i.test(language.trim());
}

export async function inUserLanguage(deps: ReviewDeps, text: string, language?: string): Promise<string> {
  if (isEnglish(language)) return text;
  try {
    const { role: agentRole, model, fallbacks, onExhausted, onFallback } = deps.roleRegistry.fallbackOpts("refiner");
    const said = await runStructuredRole({
      provider: deps.provider, role: agentRole, model, fallbacks, onExhausted, onFallback,
      // The project's own rules shape what the user reads — the same reason normalizeQuestion carries them.
      systemPrompt: PROMPT + deps.roleRegistry.ruleSuffix(),
      tools: new ToolRegistry(),
      messages: [{ role: "user", content: `Language: ${language}\n\n${text}` }],
      permission: deps.permission, approve: deps.approve, cwd: ".", signal: deps.signal,
    }, Translated);
    return said.text.trim() || text;
  } catch {
    return text; // a question in the wrong language still asks; a thrown resume does not
  }
}

export interface Choice { label: string; description?: string }

const Asked = z.object({
  question: z.string().describe("The question, in the requested language."),
  options: z.array(z.object({
    label: z.string().describe("The choice's label, in the requested language. Keep it short — it is a name."),
    description: z.string().optional().describe("Its one-line explanation, in the requested language."),
  })).describe("Same choices, same order. Never add, drop or reorder them."),
});

/**
 * A question the ENGINE asks, in the user's language — with the code's own answer left intact.
 *
 * The trap here is the answer. `askUser` returns the label that was chosen, and callers match on it:
 * `/^small/i.test(answer)` decides whether a request skips the whole spec-and-plan pipeline. Translating the
 * labels and handing the translation back would make that test silently false and take the other branch —
 * a wrong answer to a question the user answered correctly.
 *
 * So the translation is what they READ, and what comes back is the ORIGINAL label, matched by position.
 * Callers keep comparing against the English they wrote.
 *
 * Measured: a session running entirely in Turkish was asked "I cannot tell how big this is from the code…
 * Which is it? (*) Small — just do it / ( ) Full piece of work" — in English, by the engine, after the user
 * had said more than once which language they work in.
 */
export async function askInUserLanguage(
  deps: ReviewDeps,
  askUser: (q: string, o?: { options?: Choice[] }) => Promise<string>,
  language: string | undefined,
  question: string,
  options?: Choice[],
): Promise<string> {
  if (isEnglish(language) || !options?.length) {
    const q = isEnglish(language) ? question : await inUserLanguage(deps, question, language);
    return askUser(q, options ? { options } : undefined);
  }
  try {
    const { role: agentRole, model, fallbacks, onExhausted, onFallback } = deps.roleRegistry.fallbackOpts("refiner");
    const said = await runStructuredRole({
      provider: deps.provider, role: agentRole, model, fallbacks, onExhausted, onFallback,
      systemPrompt: PROMPT + deps.roleRegistry.ruleSuffix(),
      tools: new ToolRegistry(),
      messages: [{ role: "user", content: `Language: ${language}\n\n${JSON.stringify({ question, options })}` }],
      permission: deps.permission, approve: deps.approve, cwd: ".", signal: deps.signal,
    }, Asked);
    // A translation that lost or invented a choice cannot be mapped back safely — ask as written instead.
    if (said.options.length !== options.length) return askUser(question, { options });
    const answer = (await askUser(said.question, { options: said.options })).trim();
    const at = said.options.findIndex((o) => o.label.trim() === answer);
    // Matched by POSITION: the caller compares against the English it wrote, whatever the user was shown.
    return at >= 0 ? options[at]!.label : answer;
  } catch {
    return askUser(question, { options });   // a question in the wrong language still asks
  }
}
