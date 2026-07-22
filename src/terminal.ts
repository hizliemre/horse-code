import { createInterface } from "node:readline/promises";
import type { AskUser, AskOpts } from "./engine/review.js";
import type { AskHuman } from "./engine/escalation.js";
import type { PermissionRequest } from "./permission/engine.js";

export type LineReader = (prompt: string, opts?: AskOpts) => Promise<string>;

export function makeAskUser(read: LineReader): AskUser {
  return (question, opts) => read(`\n[question] ${question}`, opts);
}

export function makeApprove(read: LineReader): (req: PermissionRequest) => Promise<boolean> {
  return async (req) => {
    const ans = (await read(`\n[permission] ${req.preview}\napprove? (y/n)`)).trim().toLowerCase();
    return ans === "y" || ans === "yes";
  };
}

export function makeAskHuman(read: LineReader): AskHuman {
  return async (ctx) => {
    const notes = ctx.verdict.notes.join("; ");
    const ans = (await read(`\n[human] task "${ctx.card.title}" — ${notes}\n(accept / retry: <note> / abandon)`)).trim();
    const low = ans.toLowerCase();
    if (low === "accept") return { action: "accept" };
    if (low.startsWith("retry")) {
      const note = ans.slice(ans.indexOf(":") + 1).trim();
      return { action: "retry", notes: note && ans.includes(":") ? [note] : [] };
    }
    return { action: "abandon" };
  };
}

/**
 * Production line reader (node:readline). If `close()` isn't called, stdin stays open and the
 * process hangs → the CLI must call `close()` once the job is done.
 */
export function nodeLineReader(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): { read: LineReader; close: () => void } {
  const rl = createInterface({ input, output });
  const buffered: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let closed = false;
  rl.on("line", (line) => {
    const w = waiters.shift();
    if (w) w(line);
    else buffered.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()!(""); // remaining waiters get an empty response
  });
  // Lines are queued → consecutive reads are race-free (removes the readline/promises question race).
  // The prompt is shown via readline's own mechanism (setPrompt+prompt) → renders correctly on a TTY too.
  const read: LineReader = async (prompt, opts) => {
    // Plain-CLI fallback for choice questions: show a numbered list; the user types number(s).
    const shown = opts?.options?.length
      ? `${prompt}\n${opts.options.map((o, i) => `  ${i + 1}. ${o}`).join("\n")}` +
        (opts.multiSelect ? "\n(enter one or more numbers, comma-separated)" : "")
      : prompt;
    rl.setPrompt(shown + "\n> ");
    rl.prompt();
    let line: string;
    if (buffered.length) line = buffered.shift()!;
    else if (closed) line = "";
    else line = await new Promise<string>((resolve) => { waiters.push(resolve); });
    // Map a numeric pick (or comma-separated numbers) back to the option text; otherwise return as typed.
    const options = opts?.options;
    if (options?.length) {
      const picks = line.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
        const n = Number(s);
        return Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1] : s;
      });
      if (picks.length) return picks.join("; ");
    }
    return line;
  };
  return { read, close: () => rl.close() };
}
