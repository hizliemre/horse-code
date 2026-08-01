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
    /**
     * `flags` means REGEX flags, and a model reaching for grep reaches for grep's command line.
     *
     * Seen in a real run: `flags: "-m 3"` — grep's max-count — handed straight to `new RegExp`, which threw
     * "Invalid flags supplied to RegExp constructor" and cost the turn. Salvaging letters out of it would be
     * worse than failing: "-m 3" contains `m`, a real JS flag, so the call would have silently run in
     * multiline mode and returned a different answer than either party intended.
     *
     * So the value is taken only when it is ENTIRELY regex flags, and anything else is refused with the
     * distinction spelled out, because the model has to correct the call to get anywhere.
     */
    const flags = a.flags?.trim() ?? "";
    if (flags && !/^[dgimsuvy]+$/.test(flags)) {
      return {
        content: `grep: "${flags}" is not a regex flag. This tool takes JavaScript regex flags (i, m, s, g), `
          + `not grep's command-line options — for a case-insensitive search pass flags "i", and to limit the `
          + `number of results narrow the pattern instead.`,
        isError: true,
      };
    }
    let re: RegExp;
    try {
      re = new RegExp(a.pattern, flags);
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
