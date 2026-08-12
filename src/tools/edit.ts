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

/** How much of the file's real text an error may quote back. Enough to paste; short of re-sending the file. */
export const NEAR_MISS_CHARS = 600;

const norm = (t: string): string => t.replace(/[ \t]+/g, " ").replace(/[ \t]+$/gm, "").trim();

/**
 * Why the string was not there — instead of only that it was not.
 *
 * Measured across six consecutive runs on one project: 17 of 68 `edit_file` calls failed with
 * `oldString not found`, by `coder`, `designer` and `tester` alike — one edit in four, each costing a turn
 * and telling the agent nothing it did not already know. Ten of them were the same report file, edited over
 * and over as scenarios were recorded.
 *
 * Almost all of it is one of three things, and the file can say which: the line-number prefixes `read_file`
 * adds for display, whitespace that differs from what was quoted, or an anchor that is genuinely gone because
 * the file moved on. So the answer quotes the file's REAL bytes for the span it was clearly aiming at, which
 * is the one thing that turns a second attempt into a hit rather than another guess.
 */
export function whyNotFound(content: string, oldString: string): string {
  if (/^\s*\d+\t/m.test(oldString)) {
    return " — your oldString still carries read_file's display prefixes (`123\\t…`). Strip the number and "
      + "the tab from every line and send the file's real bytes.";
  }
  const lines = content.split("\n");
  const wanted = oldString.split("\n");
  const firstReal = wanted.find((l) => l.trim().length > 0)?.trim();
  if (firstReal === undefined) return " — your oldString is empty or only whitespace.";

  // Whitespace is the commonest miss: the text IS there, quoted with different indentation.
  if (norm(content).includes(norm(oldString))) {
    const at = lines.findIndex((l) => norm(l) === norm(wanted.find((w) => w.trim())! ) || norm(l).includes(firstReal));
    const block = at >= 0 ? lines.slice(at, at + wanted.length).join("\n") : "";
    return " — the text IS in the file, but its whitespace differs from what you sent (tabs vs spaces, or "
      + `trailing space). Here it is exactly as the file has it, from line ${at + 1}:\n`
      + block.slice(0, NEAR_MISS_CHARS);
  }

  // The anchor line exists, so the file has moved on from what you were quoting after it.
  const at = lines.findIndex((l) => l.includes(firstReal));
  if (at >= 0) {
    return ` — the file has "${firstReal.slice(0, 60)}" at line ${at + 1}, but what follows it is not what you `
      + `sent. This is what is there now:\n${lines.slice(at, at + wanted.length + 2).join("\n").slice(0, NEAR_MISS_CHARS)}`;
  }
  return " — no line of your oldString is in the file. Read it again before editing: it has changed since you "
    + "last saw it, or this is not the file you meant.";
}

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
      return {
        content: `edit_file: oldString not found (${a.path})${whyNotFound(content, a.oldString)}`,
        isError: true,
      };
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
