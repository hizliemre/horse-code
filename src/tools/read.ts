import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { Tool } from "../core/types.js";

const params = z.object({ path: z.string() });

export const readFileTool: Tool = {
  name: "read_file",
  description: "Bir dosyanın içeriğini okur (cwd'ye göreli veya mutlak yol).",
  permissionLevel: "safe",
  parameters: params,
  async run(rawArgs, ctx) {
    const parsed = params.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        content: `read_file: geçersiz args: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        isError: true,
      };
    }
    const args = parsed.data;
    try {
      const content = await readFile(resolve(ctx.cwd, args.path), "utf8");
      return { content, isError: false };
    } catch (e) {
      return {
        content: `read_file hatası: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};
