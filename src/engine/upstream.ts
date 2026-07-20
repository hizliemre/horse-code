import { z } from "zod";
import type { Tool } from "../core/types.js";
import { runToCompletion } from "../agent/loop.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { readFileTool } from "../tools/read.js";
import { writeFileTool } from "../tools/write.js";
import { editFileTool } from "../tools/edit.js";
import { grepTool } from "../tools/grep.js";
import { globTool } from "../tools/glob.js";
import { buildSkillTool } from "../skills/apply.js";
import type { ReviewDeps, AskUser } from "./review.js";

const askUserParams = z.object({ question: z.string() });

/** Analyst'in kullanıcıya soru sorması için tool (buildSkillTool paterni); cevabı content'te döner. */
export function buildAskUserTool(askUser: AskUser): Tool {
  return {
    name: "ask_user",
    description: "Kullanıcıya bir soru sor ve cevabını al.",
    permissionLevel: "safe",
    parameters: askUserParams,
    run: async (rawArgs) => {
      const parsed = askUserParams.safeParse(rawArgs);
      if (!parsed.success) {
        return { content: `ask_user: geçersiz args: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
      }
      const answer = await askUser(parsed.data.question);
      return { content: answer, isError: false };
    },
  };
}

/** Dosya-yazan rollerin toolset'i: read/write/edit/grep/glob + skill (+ extra); shell/web YOK. */
function writerRegistry(deps: ReviewDeps, extra: Tool[] = []): ToolRegistry {
  const r = new ToolRegistry();
  r.register(readFileTool);
  r.register(writeFileTool);
  r.register(editFileTool);
  r.register(grepTool);
  r.register(globTool);
  r.register(buildSkillTool(deps.skillRegistry));
  for (const t of extra) r.register(t);
  return r;
}

/** Analyst: ask_user ile soru sorup spec dosyasını yazar (revize'de feedback ile). */
export async function runAnalyst(
  deps: ReviewDeps,
  workdir: string,
  specPath: string,
  prompt: string,
  feedback: string[] | undefined,
  askUser: AskUser,
): Promise<void> {
  const { model, systemPrompt } = deps.roleRegistry.resolve("analyst");
  const tools = writerRegistry(deps, [buildAskUserTool(askUser)]);
  const content =
    feedback && feedback.length
      ? `"${specPath}" spec'ini şu reviewer notlarıyla revize et:\n${feedback.map((f) => `- ${f}`).join("\n")}\nOrijinal istek: ${prompt}`
      : `İstek: "${prompt}". Gerekirse ask_user ile kullanıcıya sor; spec dosyasını "${specPath}"'e write_file ile yaz.`;
  const opts: RoleAgentOptions = {
    provider: deps.provider, model, systemPrompt, tools,
    messages: [{ role: "user", content }],
    permission: deps.permission, approve: deps.approve, cwd: workdir, signal: deps.signal,
  };
  await runToCompletion(opts);
}
