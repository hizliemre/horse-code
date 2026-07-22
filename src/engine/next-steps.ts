export interface ParsedResponse {
  text: string; // the reply with the <nextsteps> block removed
  steps: string[]; // suggested follow-up prompts (may be empty)
}

/**
 * Splits an optional `<nextsteps>…</nextsteps>` block out of a coach reply. Inside the block, each list
 * item (─, *, or "N.") becomes a suggested follow-up. The block is stripped from the returned text.
 */
export function parseNextSteps(raw: string): ParsedResponse {
  const m = raw.match(/<nextsteps>([\s\S]*?)<\/nextsteps>/i);
  if (!m || m.index === undefined) return { text: raw.trim(), steps: [] };
  const steps = m[1]
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 6);
  const text = (raw.slice(0, m.index) + raw.slice(m.index + m[0].length)).trim();
  return { text, steps };
}
