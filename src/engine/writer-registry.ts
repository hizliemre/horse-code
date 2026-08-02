import { z } from "zod";
import type { Tool } from "../core/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { readFileTool } from "../tools/read.js";
import { writeFileTool } from "../tools/write.js";
import { editFileTool } from "../tools/edit.js";
import { grepTool } from "../tools/grep.js";
import { globTool } from "../tools/glob.js";
import { buildSkillTool } from "../skills/apply.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { AskUser } from "./review.js";
import { looksLikeChoices, extractChoicesFrom, type NormalizedQuestion } from "./normalize-question.js";

const askUserParams = z.object({
  question: z.string(),
  // For a multiple-choice question, list the choices here → the UI shows a selectable checkbox/radio list
  // (arrow keys + Enter) instead of a free-text box. Omit for an open-ended question.
  //
  // A choice may be a plain string, or an object carrying what the label alone cannot say: a one-line
  // `description`, and a `preview` rendered in a panel beside the list while that option is focused. Use the
  // rich form when the decision turns on the trade-offs rather than the name (e.g. "which approach?").
  options: z.array(z.union([
    z.string(),
    z.object({ label: z.string(), description: z.string().optional(), preview: z.string().optional() }),
  ])).optional(),
  // Set true when the user may pick more than one option (checkboxes); false/omitted = pick one (radio).
  multiSelect: z.boolean().optional(),
});

/**
 * Tool for a role to ask the user a question; returns the answer in content. `normalize` (optional) rescues
 * the common case where the model embeds the choices in the question prose (a table / A-B-C list) instead of
 * passing `options`: it extracts them so the UI can still render a selectable list.
 */
export function buildAskUserTool(
  askUser: AskUser,
  normalize?: (question: string) => Promise<NormalizedQuestion>,
): Tool {
  return {
    name: "ask_user",
    description:
      "Ask the user a question and get their answer. For a multiple-choice question, pass `options` (the " +
      "choices) — the UI shows a selectable list the user checks off; set `multiSelect: true` when they may " +
      "pick several. Omit `options` for an open-ended (free-text) question. An option may be a plain string, " +
      "or {label, description, preview} when the decision turns on trade-offs the label cannot carry — the " +
      "preview is shown beside the list as the user moves the cursor. A `label` is a SHORT single line (a few " +
      "words, no line breaks): it is a name for the choice, not the argument for it. Put the reasoning in " +
      "`description` (one sentence) and the detail in `preview`. If you have findings to report, WRITE THEM " +
      "as your message before calling this — a question that says \"the evaluation is above\" when you never " +
      "wrote one leaves the user choosing between options whose basis they cannot see. The user may attach a " +
      "free-text note to their choice, which arrives appended to the answer.",
    permissionLevel: "safe",
    parameters: askUserParams,
    run: async (rawArgs) => {
      const parsed = askUserParams.safeParse(rawArgs);
      if (!parsed.success) {
        return { content: `ask_user: invalid args: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
      }
      const { question, options, multiSelect } = parsed.data;
      // If the model didn't pass structured options but the text looks like it embeds choices, extract them
      // (via `normalize`) so the user gets a real selectable list instead of a wall of prose.
      if ((!options || options.length === 0) && looksLikeChoices(question)) {
        // The question already lists its choices — read them rather than paying a model to restate them.
        const found = extractChoicesFrom(question);
        if (found.choices.length >= 2) {
          // The trimmed question, so the list is not printed twice — once as prose, once as the list.
          return { content: await askUser(found.question, { options: found.choices }), isError: false };
        }
        // Only prose that hides its choices needs a model.
        if (normalize) {
          try {
            const n = await normalize(question);
            if (n.options.length > 0) {
              return { content: await askUser(n.question, { options: n.options, multiSelect: n.multiSelect }), isError: false };
            }
          } catch { /* normalizer failed → fall through to the raw question */ }
        }
      }
      return { content: await askUser(question, { options, multiSelect }), isError: false };
    },
  };
}

/** Toolset for file-writing roles: read/write/edit/grep/glob + skill (+ extra); NO shell/web. */
export function writerRegistry(skillRegistry: SkillRegistry, extra: Tool[] = []): ToolRegistry {
  const r = new ToolRegistry();
  r.register(readFileTool);
  r.register(writeFileTool);
  r.register(editFileTool);
  r.register(grepTool);
  r.register(globTool);
  r.register(buildSkillTool(skillRegistry));
  for (const t of extra) r.register(t);
  return r;
}
