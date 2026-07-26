import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { z } from "zod";
import type { Tool } from "../core/types.js";

const params = z.object({ path: z.string(), content: z.string() });

export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Writes content to a file (creates parent directories). Creating a NEW file is always allowed; to " +
    "OVERWRITE an existing file you must read_file it first in this run — otherwise the write is refused.",
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
    // Overwriting a file this agent has never looked at destroys content it cannot know about — a sibling
    // task's work in a shared worktree, or a file it is about to rewrite from memory. Creating a NEW file is
    // unaffected: there is nothing to lose.
    if (ctx.readFiles && existsSync(target) && !ctx.readFiles.has(target)) {
      return {
        content: `write_file: refusing to overwrite ${a.path} — read_file it first so you know what you are replacing (or use edit_file for a targeted change).`,
        isError: true,
      };
    }
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, a.content, "utf8");
      { const ls = a.content ? a.content.split("\n") : []; ctx.onActivity?.({ tool: "write", target: a.path, lines: ls.length, preview: ls.slice(0, 12), startLine: 1 }); }
      ctx.readFiles?.add(target); // we now know its contents — a follow-up rewrite is not blind
      return { content: `Written: ${a.path}`, isError: false };
    } catch (e) {
      return {
        content: `write_file error: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  },
};
