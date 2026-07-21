import { relative, sep } from "node:path";
import picomatch from "picomatch";
import { z } from "zod";
import type { Tool } from "../core/types.js";
import { walkFiles } from "./walk.js";

const params = z.object({ pattern: z.string() });
const MAX_RESULTS = 500;

export const globTool: Tool = {
  name: "glob",
  description: "Finds file paths under cwd matching a glob pattern.",
  permissionLevel: "safe",
  parameters: params,
  async run(rawArgs, ctx) {
    const parsed = params.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        content: `glob: geçersiz args: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        isError: true,
      };
    }
    const a = parsed.data;
    const isMatch = picomatch(a.pattern);
    const out: string[] = [];
    for await (const abs of walkFiles(ctx.cwd)) {
      // picomatch POSIX ayraç bekler; Windows'ta normalize et.
      const rel = relative(ctx.cwd, abs).split(sep).join("/");
      if (isMatch(rel)) {
        out.push(rel);
        if (out.length >= MAX_RESULTS) {
          out.push(`… (${MAX_RESULTS}+ sonuç, kesildi)`);
          break;
        }
      }
    }
    return { content: out.length ? out.join("\n") : "eşleşme yok", isError: false };
  },
};
