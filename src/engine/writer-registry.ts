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

const askUserParams = z.object({ question: z.string() });

/** Tool for a role to ask the user a question; returns the answer in content. */
export function buildAskUserTool(askUser: AskUser): Tool {
  return {
    name: "ask_user",
    description: "Ask the user a question and get their answer.",
    permissionLevel: "safe",
    parameters: askUserParams,
    run: async (rawArgs) => {
      const parsed = askUserParams.safeParse(rawArgs);
      if (!parsed.success) {
        return { content: `ask_user: invalid args: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
      }
      return { content: await askUser(parsed.data.question), isError: false };
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
