export interface ExtractedBlock {
  text: string; // the reply with the <tag>…</tag> block removed
  items: string[]; // list items parsed from inside the block (may be empty)
}

/**
 * Pulls an optional `<tag>…</tag>` block out of a coach reply. Inside the block, each list item
 * (─, *, or "N.") becomes an item. The block is stripped from the returned text.
 */
export function extractListBlock(raw: string, tag: string): ExtractedBlock {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const m = raw.match(re);
  if (!m || m.index === undefined) return { text: raw.trim(), items: [] };
  const items = m[1]
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 6);
  const text = (raw.slice(0, m.index) + raw.slice(m.index + m[0].length)).trim();
  return { text, items };
}

export interface ParsedResponse {
  text: string;
  steps: string[];
}

/** Backward-compatible next-steps parse (thin wrapper over extractListBlock). */
export function parseNextSteps(raw: string): ParsedResponse {
  const { text, items } = extractListBlock(raw, "nextsteps");
  return { text, steps: items };
}
