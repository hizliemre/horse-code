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
  description:
    "Performs an exact string replacement in a file. oldString must match the file's REAL bytes — strip the " +
    "`<number>\\t` prefix that read_file adds for display, or nothing will match. oldString must be unique " +
    "(otherwise replaceAll is required); a miss is reported as an error, never a silent no-op.",
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
        content: `edit_file: invalid args: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        isError: true,
      };
    }
    const a = parsed.data;
    const target = resolve(ctx.cwd, a.path);
    const cwdResolved = resolve(ctx.cwd);
    if (target !== cwdResolved && !target.startsWith(cwdResolved + sep)) {
      return { content: `edit_file: path is outside cwd: ${a.path}`, isError: true };
    }
    let content: string;
    try {
      content = await readFile(target, "utf8");
    } catch (e) {
      return {
        content: `edit_file error: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
    const count = content.split(a.oldString).length - 1;
    if (count === 0) {
      return { content: `edit_file: oldString not found (${a.path})`, isError: true };
    }
    if (count > 1 && !a.replaceAll) {
      return {
        content: `edit_file: oldString is not unique (${count} matches) — replaceAll required`,
        isError: true,
      };
    }
    const next = a.replaceAll
      ? content.split(a.oldString).join(a.newString)
      : content.replace(a.oldString, a.newString);
    try {
      await writeFile(target, next, "utf8");
      {
        const added = a.newString ? a.newString.split("\n") : [];
        const removed = a.oldString ? a.oldString.split("\n") : [];
        const at = content.indexOf(a.oldString);
        const startLine = at < 0 ? 1 : content.slice(0, at).split("\n").length; // 1-based line of the change
        ctx.onActivity?.({ tool: "edit", target: a.path, lines: added.length, preview: added.slice(0, 12), removed: removed.slice(0, 12), startLine });
      }
      return { content: `Edited: ${a.path}`, isError: false };
    } catch (e) {
      return {
        content: `edit_file error: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};
