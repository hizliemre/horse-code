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
  ])).optional().describe(
    "The choices, when the question has discrete answers — the UI renders a selectable list instead of a "
    + "free-text box. Omit for an open-ended question. A choice may be a plain string, or an object with a "
    + "one-line `description` and a `preview` shown beside the list; use the rich form when the decision "
    + "turns on trade-offs rather than on the name."),
  multiSelect: z.boolean().optional().describe(
    "True when the user may pick more than one (checkboxes); omitted means pick exactly one (radio)."),
  /**
   * What the user has to DO before they can answer — one action per entry.
   *
   * Present ⇒ this is a hand-off, not a question: the run has stopped because only a person can carry the
   * next step, and the UI says so rather than showing a bare "? Question".
   */
  steps: z.array(z.string()).optional().describe(
    "What the user has to DO before they can answer — one action per entry. Supplying this makes it a "
    + "HAND-OFF rather than a question: the run has stopped because only a person can carry the next step, "
    + "and the UI says so instead of showing a bare \"? Question\". Use it whenever you are asking someone "
    + "to go and perform something and report back; leave it out when you only want an answer."),
});

/**
 * A question that points at something instead of carrying it.
 *
 * Measured live: a tester wrote its scenario into the test-plan document, then asked "share your
 * Network/UI observation according to the 5 items above" — and the 5 items were in a file on a branch the
 * developer was not looking at. The reply was "the steps aren't in the chat?". The document an agent writes
 * is not on the user's screen; the question box is.
 */
const POINTS_ELSEWHERE = /\b(above|below|earlier|previously|as listed|as described)\b|yukarı|aşağı|önceki|birazdan|listelenen/i;

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
      "free-text note to their choice, which arrives appended to the answer.\n\n" +
      "When you need the user to DO something first — click through a screen, run a scenario, look at a " +
      "network response — put each action in `steps`, one per entry, and ask in `question` for what they " +
      "should report back. The user reads THIS BOX and the chat; a file you wrote is not on their screen, so " +
      "\"the steps above\" points at nothing they can see. With `steps` the UI shows a hand-off — the numbered " +
      "actions and then the question — instead of a bare question.",
    permissionLevel: "safe",
    parameters: askUserParams,
    run: async (rawArgs, ctx) => {
      const parsed = askUserParams.safeParse(rawArgs);
      if (!parsed.success) {
        return { content: `ask_user: invalid args: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
      }
      const { question, options, multiSelect, steps } = parsed.data;
      // Who is asking, carried on every route below — the user sees a question, not a process tree.
      const asker = ctx.role || ctx.model ? { asker: { ...(ctx.role ? { role: ctx.role } : {}), ...(ctx.model ? { model: ctx.model } : {}) } } : {};
      /**
       * A dangling pointer is refused, not shown.
       *
       * Only when all three hold: the question points somewhere, it carries nothing itself, and the turn
       * said nothing either — so there is provably nothing on the user's screen to point AT. A question
       * that follows a message the user can read is left alone; that reference resolves.
       */
      if (POINTS_ELSEWHERE.test(question) && !steps?.length && !ctx.said?.trim()) {
        return {
          content: "ask_user: this question refers to something the user cannot see. You wrote no message "
            + "this turn, so there is nothing above it — and a file you wrote is not on their screen. Put "
            + "what they must do in `steps` (one action per entry), or write it out in `question`, and ask "
            + "again.",
          isError: true,
        };
      }
      // If the model didn't pass structured options but the text looks like it embeds choices, extract them
      // (via `normalize`) so the user gets a real selectable list instead of a wall of prose.
      if ((!options || options.length === 0) && !steps?.length && looksLikeChoices(question)) {
        // The question already lists its choices — read them rather than paying a model to restate them.
        const found = extractChoicesFrom(question);
        if (found.choices.length >= 2) {
          // The trimmed question, so the list is not printed twice — once as prose, once as the list.
          return { content: await askUser(found.question, { options: found.choices, ...asker }), isError: false };
        }
        // Only prose that hides its choices needs a model.
        if (normalize) {
          try {
            const n = await normalize(question);
            if (n.options.length > 0) {
              return { content: await askUser(n.question, { options: n.options, multiSelect: n.multiSelect, ...asker }), isError: false };
            }
          } catch { /* normalizer failed → fall through to the raw question */ }
        }
      }
      return { content: await askUser(question, { options, multiSelect, steps, ...asker }), isError: false };
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
