import { readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import type { Tool } from "../core/types.js";

const params = z.object({
  path: z.string(),
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
});

export const editFileTool: Tool = {
  name: "edit_file",
  description: "Bir dosyada birebir string değişimi yapar. oldString benzersiz olmalı (yoksa replaceAll gerekir).",
  permissionLevel: "write",
  parameters: params,
  describe(rawArgs) {
    const a = params.parse(rawArgs);
    return { allowKey: a.path, preview: `edit ${a.path}` };
  },
  async run(rawArgs, ctx) {
    const parsed = params.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        content: `edit_file: geçersiz args: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        isError: true,
      };
    }
    const a = parsed.data;
    const target = resolve(ctx.cwd, a.path);
    const cwdResolved = resolve(ctx.cwd);
    if (target !== cwdResolved && !target.startsWith(cwdResolved + sep)) {
      return { content: `edit_file: yol cwd dışında: ${a.path}`, isError: true };
    }
    let content: string;
    try {
      content = await readFile(target, "utf8");
    } catch (e) {
      return {
        content: `edit_file hatası: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
    const count = content.split(a.oldString).length - 1;
    if (count === 0) {
      return { content: `edit_file: oldString bulunamadı (${a.path})`, isError: true };
    }
    if (count > 1 && !a.replaceAll) {
      return {
        content: `edit_file: oldString benzersiz değil (${count} eşleşme) — replaceAll gerekli`,
        isError: true,
      };
    }
    const next = a.replaceAll
      ? content.split(a.oldString).join(a.newString)
      : content.replace(a.oldString, a.newString);
    try {
      await writeFile(target, next, "utf8");
      return { content: `Düzenlendi: ${a.path}`, isError: false };
    } catch (e) {
      return {
        content: `edit_file hatası: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};
