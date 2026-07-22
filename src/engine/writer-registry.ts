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

const askUserParams = z.object({
  question: z.string(),
  // For a multiple-choice question, list the choices here → the UI shows a selectable checkbox/radio list
  // (arrow keys + Enter) instead of a free-text box. Omit for an open-ended question.
  options: z.array(z.string()).optional(),
  // Set true when the user may pick more than one option (checkboxes); false/omitted = pick one (radio).
  multiSelect: z.boolean().optional(),
});

/** Tool for a role to ask the user a question; returns the answer in content. */
export function buildAskUserTool(askUser: AskUser): Tool {
  return {
    name: "ask_user",
    description:
      "Ask the user a question and get their answer. For a multiple-choice question, pass `options` (the " +
      "choices) — the UI shows a selectable list the user checks off; set `multiSelect: true` when they may " +
      "pick several. Omit `options` for an open-ended (free-text) question.",
    permissionLevel: "safe",
    parameters: askUserParams,
    run: async (rawArgs) => {
      const parsed = askUserParams.safeParse(rawArgs);
      if (!parsed.success) {
        return { content: `ask_user: invalid args: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
      }
      const { question, options, multiSelect } = parsed.data;
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
