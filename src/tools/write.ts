import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { z } from "zod";
import type { Tool } from "../core/types.js";

const params = z.object({ path: z.string(), content: z.string() });

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Writes content to a file (overwrites, creates parent directories).",
  permissionLevel: "write",
  parameters: params,
  describe(rawArgs) {
    const a = params.parse(rawArgs);
    return { allowKey: a.path, preview: `write ${a.path} (${Buffer.byteLength(a.content)} bytes)` };
  },
  async run(rawArgs, ctx) {
    const parsed = params.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        content: `write_file: invalid args: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        isError: true,
      };
    }
    const a = parsed.data;
    const target = resolve(ctx.cwd, a.path);
    const cwdResolved = resolve(ctx.cwd);
    if (target !== cwdResolved && !target.startsWith(cwdResolved + sep)) {
      return { content: `write_file: path is outside cwd: ${a.path}`, isError: true };
    }
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, a.content, "utf8");
      { const ls = a.content ? a.content.split("\n") : []; ctx.onActivity?.({ tool: "write", target: a.path, lines: ls.length, preview: ls.slice(0, 12), startLine: 1 }); }
      return { content: `Written: ${a.path}`, isError: false };
    } catch (e) {
      return {
        content: `write_file error: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};
