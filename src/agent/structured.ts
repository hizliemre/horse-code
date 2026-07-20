import type { z } from "zod";
import type { Tool } from "../core/types.js";

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
