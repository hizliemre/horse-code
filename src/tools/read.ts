import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { Tool } from "../core/types.js";

const params = z.object({
  path: z.string(),
  /** 1-based first line to return. Use it to page through a file that came back truncated. */
  offset: z.number().int().min(1).optional(),
  /** How many lines to return starting at `offset`. */
  limit: z.number().int().min(1).optional(),
});

/**
 * Cap on how much of a file one call may return (~7.5k tokens).
 *
 * An uncapped read is the most expensive thing an agent can do here: the whole file enters the conversation and
 * is then re-sent on EVERY subsequent turn, so one large read is billed dozens of times over. A review lens
 * that pulled in a big file was observed spending 1.9M prompt tokens to produce 21k of output.
 *
 * Deliberately tighter than "one big file": paging costs one extra call, while an over-large read costs its
 * whole size again on every turn that follows. An agent that needs more asks for the next window.
 */
export const MAX_READ_CHARS = 30_000;

/** Cuts `lines` down to the char budget; returns the kept slice and how many lines were dropped. */
function fit(lines: string[], budget: number): { kept: string[]; dropped: number } {
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    used += lines[i].length + 1;
    if (used > budget) return { kept: lines.slice(0, i), dropped: lines.length - i };
  }
  return { kept: lines, dropped: 0 };
}

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Reads a file (path relative to cwd or absolute). Large files come back truncated; pass `offset` (1-based " +
    "line) and `limit` (line count) to read a specific range. Read only what you need — every line you read " +
    "stays in your context for the rest of the turn.",
  permissionLevel: "safe",
  parameters: params,
  async run(rawArgs, ctx) {
    const parsed = params.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        content: `read_file: invalid args: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        isError: true,
      };
    }
    const args = parsed.data;
    let raw: string;
    try {
      raw = await readFile(resolve(ctx.cwd, args.path), "utf8");
    } catch (e) {
      return {
        content: `read_file error: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
    // A small file, requested whole, is returned verbatim — the overwhelmingly common case, unchanged.
    if (args.offset === undefined && args.limit === undefined && raw.length <= MAX_READ_CHARS) {
      return { content: raw, isError: false };
    }
    const all = raw.split("\n");
    const start = (args.offset ?? 1) - 1;
    if (start >= all.length) {
      return { content: `read_file: offset ${args.offset} is past the end of the file (${all.length} lines).`, isError: true };
    }
    const window = args.limit !== undefined ? all.slice(start, start + args.limit) : all.slice(start);
    const { kept } = fit(window, MAX_READ_CHARS);
    const last = start + kept.length;
    // The footer is the affordance: without it an agent cannot tell a short file from a truncated one, and
    // would reason confidently about content it never saw.
    const footer = last < all.length
      ? `\n\n[read_file: lines ${start + 1}-${last} of ${all.length}. Re-read with {"path":"${args.path}","offset":${last + 1}} for the rest.]`
      : `\n\n[read_file: lines ${start + 1}-${last} of ${all.length}.]`;
    return { content: kept.join("\n") + footer, isError: false };
  },
};
