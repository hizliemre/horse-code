import { createInterface } from "node:readline/promises";
import type { AskUser } from "./engine/review.js";
import type { AskHuman } from "./engine/escalation.js";
import type { PermissionRequest } from "./permission/engine.js";

export type LineReader = (prompt: string) => Promise<string>;

export function makeAskUser(read: LineReader): AskUser {
  return (question) => read(`\n[soru] ${question}`);
}

export function makeApprove(read: LineReader): (req: PermissionRequest) => Promise<boolean> {
  return async (req) => {
    const ans = (await read(`\n[izin] ${req.preview}\nonayla? (e/h)`)).trim().toLowerCase();
    return ans === "e" || ans === "evet" || ans === "y" || ans === "yes";
  };
}

export function makeAskHuman(read: LineReader): AskHuman {
  return async (ctx) => {
    const notes = ctx.verdict.notes.join("; ");
    const ans = (await read(`\n[insan] task "${ctx.card.title}" — ${notes}\n(accept / retry: <not> / abandon)`)).trim();
    const low = ans.toLowerCase();
    if (low === "accept" || low === "kabul") return { action: "accept" };
    if (low.startsWith("retry")) {
      const note = ans.slice(ans.indexOf(":") + 1).trim();
      return { action: "retry", notes: note && ans.includes(":") ? [note] : [] };
    }
    return { action: "abandon" };
  };
}

/**
 * Üretim satır-okuyucusu (node:readline). `close()` çağrılmazsa stdin açık kalır ve süreç
 * asılı kalır → CLI iş bitince `close()` etmeli.
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
    while (waiters.length) waiters.shift()!(""); // kalan bekleyenlere boş cevap
  });
  // Satırlar kuyruklanır → ardışık read'ler race'siz (readline/promises question race'i giderilir).
  // Prompt gösterimi readline'ın kendi mekanizmasıyla (setPrompt+prompt) → TTY'de de düzgün görünür.
  const read: LineReader = (prompt) => {
    rl.setPrompt(prompt + "\n> ");
    rl.prompt();
    if (buffered.length) return Promise.resolve(buffered.shift()!);
    if (closed) return Promise.resolve("");
    return new Promise<string>((resolve) => { waiters.push(resolve); });
  };
  return { read, close: () => rl.close() };
}
