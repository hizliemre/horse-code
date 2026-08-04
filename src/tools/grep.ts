import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { z } from "zod";
import type { Tool } from "../core/types.js";
import { walkFiles } from "./walk.js";

const params = z.object({ pattern: z.string(), flags: z.string().optional() });
const MAX_MATCHES = 200;

/**
 * A cap on the number of MATCHES is not a cap on the amount of TEXT.
 *
 * A match is a line and a line has no length limit. Measured on a real project: `graphify-out/graph.json` is
 * a single line of 35,272,070 characters — a file horse-code itself commits — so one match returned
 * thirty-five megabytes. In a live run a brainstormer's prompt reached 3,397,616 characters in one call, and
 * after that nothing it did could work.
 *
 * Long enough to read a line of real source with its context; short enough that a minified bundle, a lockfile
 * or a serialised graph cannot become the conversation.
 */
export const MAX_GREP_LINE = 400;
/** …and a ceiling on the whole answer, because many medium lines add up to the same problem. */
export const MAX_GREP_CHARS = 60_000;

/**
 * A long line, cut AROUND its match.
 *
 * Cutting from the start would keep the length under control and lose the thing being looked for: in a
 * 35-megabyte line the match is nowhere near the beginning, and a grep result without the match in it is
 * worse than no result — it looks like an answer.
 */
export function clipLine(line: string, re: RegExp): string {
  if (line.length <= MAX_GREP_LINE) return line;
  // `re` is used with `.test` elsewhere; `search` needs it unanchored to state, so a fresh copy is used.
  const at = line.search(new RegExp(re.source, re.flags.replace("g", "")));
  const half = Math.floor(MAX_GREP_LINE / 2);
  const start = Math.max(0, (at < 0 ? 0 : at) - half);
  const end = Math.min(line.length, start + MAX_GREP_LINE);
  const head = start > 0 ? "…" : "";
  const tail = end < line.length ? "…" : "";
  return `${head}${line.slice(start, end)}${tail} (line cut at ${MAX_GREP_LINE} of ${line.length} chars)`;
}

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
    let size = 0;
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
          const line = clipLine(lines[i], re);
          out.push(`${rel}:${i + 1}:${line}`);
          size += line.length + rel.length + 8;
          if (out.length >= MAX_MATCHES) {
            out.push(`… (${MAX_MATCHES}+ matches, truncated)`);
            return { content: out.join("\n"), isError: false };
          }
          if (size >= MAX_GREP_CHARS) {
            out.push(`… (result truncated at ${MAX_GREP_CHARS} characters — narrow the pattern or the path)`);
            return { content: out.join("\n"), isError: false };
          }
        }
      }
    }
    return { content: out.length ? out.join("\n") : "no matches", isError: false };
  },
};
