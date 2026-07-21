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
export function nodeLineReader(): { read: LineReader; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return { read: (prompt) => rl.question(prompt + "\n> "), close: () => rl.close() };
}
