import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { loadMigratedSync, isMigrated, migratedNotice } from "../migrate/migrated.js";
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

/**
 * Prefixes each line with its 1-based number, `cat -n` style.
 *
 * Without it an agent has no way to say WHERE something is: it cannot cite a location back, and a windowed
 * read gives no anchor for the next `offset`. The number is presentation only — the tool description tells the
 * model not to carry it into an edit, because `edit_file` matches the file's real bytes.
 */
function numbered(lines: string[], startLine: number): string {
  const width = String(startLine + lines.length - 1).length;
  return lines.map((l, i) => `${String(startLine + i).padStart(width, " ")}\t${l}`).join("\n");
}

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
    "Reads a file (path relative to cwd or absolute). Output is LINE-NUMBERED as `<number>\\t<content>` — the " +
    "number is a reading aid, NOT part of the file: never include it in an edit_file oldString or a write_file " +
    "body. Large files come back truncated; pass `offset` (1-based line) and `limit` (line count) to read a " +
    "specific range. Read only what you need — every line you read stays in your context for the rest of the turn.",
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
    const abs = resolve(ctx.cwd, args.path);
    /**
     * A migrated rule file answers with where its rules went, not with its text.
     *
     * `CLAUDE.md` and its siblings are another tool's system prompt. After migration their content lives in
     * this project's memory, which every role already carries — so the file on disk is a second copy that
     * stopped moving on the day it was read. An agent that opens it gets the rules as they WERE and trusts
     * them over the memory it was given, silently, with no way for anyone to notice.
     *
     * Answered rather than refused: a refusal invites another way in (glob, shell, a different path). A
     * sentence saying the rules are already in context is something the agent can act on.
     */
    const migrated = loadMigratedSync(ctx.cwd, (p) => readFileSync(p, "utf8"));
    if (isMigrated(migrated, args.path) && migrated) {
      return { content: migratedNotice(args.path, migrated), isError: false };
    }
    // Registered BEFORE the await, not after: auto-approved tool calls in one turn run in PARALLEL, so a
    // read+write issued together would otherwise race and the write would be refused at random. Recording the
    // intent is enough — the guard exists to catch a write with NO read at all, not to police ordering.
    ctx.readFiles?.add(abs);
    let raw: string;
    try {
      raw = await readFile(abs, "utf8");
    } catch (e) {
      return {
        content: `read_file error: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
    const all = raw.split("\n");
    // A small file, requested whole: numbered, no footer — there is nothing to page.
    if (args.offset === undefined && args.limit === undefined && raw.length <= MAX_READ_CHARS) {
      return { content: numbered(all, 1), isError: false };
    }
    const start = (args.offset ?? 1) - 1;
    if (start >= all.length) {
      return { content: `read_file: offset ${args.offset} is past the end of the file (${all.length} lines).`, isError: true };
    }
    const window = args.limit !== undefined ? all.slice(start, start + args.limit) : all.slice(start);
    // The budget is on what actually ENTERS the context, so it is applied to the NUMBERED output — the prefix
    // is real bytes too. Fit on the raw text first, then shed lines until the rendered form fits.
    const { kept } = fit(window, MAX_READ_CHARS);
    while (kept.length > 1 && numbered(kept, start + 1).length > MAX_READ_CHARS) kept.pop();
    const last = start + kept.length;
    // The footer is the affordance: without it an agent cannot tell a short file from a truncated one, and
    // would reason confidently about content it never saw.
    const footer = last < all.length
      ? `\n\n[read_file: lines ${start + 1}-${last} of ${all.length}. Re-read with {"path":"${args.path}","offset":${last + 1}} for the rest.]`
      : `\n\n[read_file: lines ${start + 1}-${last} of ${all.length}.]`;
    return { content: numbered(kept, start + 1) + footer, isError: false };
  },
};
