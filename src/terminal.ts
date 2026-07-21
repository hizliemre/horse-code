import { createInterface } from "node:readline/promises";
import type { AskUser } from "./engine/review.js";
import type { AskHuman } from "./engine/escalation.js";
import type { PermissionRequest } from "./permission/engine.js";

export type LineReader = (prompt: string) => Promise<string>;

export function makeAskUser(read: LineReader): AskUser {
  return (question) => read(`\n[question] ${question}`);
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
  const read: LineReader = (prompt) => {
    rl.setPrompt(prompt + "\n> ");
    rl.prompt();
    if (buffered.length) return Promise.resolve(buffered.shift()!);
    if (closed) return Promise.resolve("");
    return new Promise<string>((resolve) => { waiters.push(resolve); });
  };
  return { read, close: () => rl.close() };
}
