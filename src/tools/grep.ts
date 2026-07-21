import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { z } from "zod";
import type { Tool } from "../core/types.js";
import { walkFiles } from "./walk.js";

const params = z.object({ pattern: z.string(), flags: z.string().optional() });
const MAX_MATCHES = 200;

export const grepTool: Tool = {
  name: "grep",
  description: "Performs a line-based regex search in files under cwd.",
  permissionLevel: "safe",
  parameters: params,
  async run(rawArgs, ctx) {
    const parsed = params.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        content: `grep: invalid args: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        isError: true,
      };
    }
    const a = parsed.data;
    let re: RegExp;
    try {
      re = new RegExp(a.pattern, a.flags ?? "");
    } catch (e) {
      return {
        content: `grep: invalid regex: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
    const out: string[] = [];
    for await (const abs of walkFiles(ctx.cwd)) {
      let text: string;
      try {
        text = await readFile(abs, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue; // skip binary files (null byte)
      const rel = relative(ctx.cwd, abs);
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          out.push(`${rel}:${i + 1}:${lines[i]}`);
          if (out.length >= MAX_MATCHES) {
            out.push(`… (${MAX_MATCHES}+ matches, truncated)`);
            return { content: out.join("\n"), isError: false };
          }
        }
      }
    }
    return { content: out.length ? out.join("\n") : "no matches", isError: false };
  },
};
