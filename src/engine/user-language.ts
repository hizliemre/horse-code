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
    const { model, fallbacks, onExhausted, onFallback } = deps.roleRegistry.fallbackOpts("refiner");
    const said = await runStructuredRole({
      provider: deps.provider, model, fallbacks, onExhausted, onFallback,
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
