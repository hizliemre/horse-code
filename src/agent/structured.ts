import type { z } from "zod";
import type { Tool } from "../core/types.js";
import { runRoleAgent, type RoleAgentOptions } from "./loop.js";
import { ToolRegistry } from "../tools/registry.js";

export interface SubmitToolHandle<T> {
  tool: Tool;
  result(): { value: T } | undefined;
}

/**
 * Parametreleri = verilen zod şeması olan bir "submit" tool'u ve yakalayıcı kutu döner.
 * Model submit'i çağırınca args doğrulanır; geçerliyse kutuya yazılır, geçersizse isError döner.
 */
export function buildSubmitTool<T>(schema: z.ZodType<T>): SubmitToolHandle<T> {
  let box: { value: T } | undefined;
  const tool: Tool = {
    name: "submit",
    description: "İşin bittiğinde sonucunu bu araçla yapılandırılmış olarak gönder.",
    permissionLevel: "safe",
    parameters: schema,
    run: async (rawArgs) => {
      const parsed = schema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          content: `submit: geçersiz çıktı: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          isError: true,
        };
      }
      box = { value: parsed.data };
      return { content: "alındı", isError: false };
    },
  };
  return { tool, result: () => box };
}

/**
 * Bir role'ü yapılandırılmış çıktı üretecek şekilde koşar: submit tool'unu role'ün
 * registry'sine ekler, runRoleAgent'ı sürer, geçerli submit yakalanınca doğrulanmış nesneyi döner.
 */
export async function runStructuredRole<T>(
  opts: RoleAgentOptions,
  schema: z.ZodType<T>,
): Promise<T> {
  const handle = buildSubmitTool(schema);
  const registry = new ToolRegistry();
  for (const t of opts.tools.list()) registry.register(t);
  registry.register(handle.tool);

  for await (const ev of runRoleAgent({ ...opts, tools: registry })) {
    if (ev.type === "error") throw new Error(ev.message);
    if (ev.type === "abort") throw new Error("iptal edildi");
    if (handle.result() !== undefined) break; // geçerli submit yakalandı → erken çık
  }

  const r = handle.result();
  if (r === undefined) throw new Error("structured role: submit çağrılmadı");
  return r.value;
}
