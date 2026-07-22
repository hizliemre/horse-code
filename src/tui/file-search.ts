import { relative } from "node:path";
import { walkFiles } from "../tools/walk.js";

/**
 * Fuzzy subsequence score of `query` against `target`. Higher is better; -1 means no match (not every
 * query char occurs in order). Rewards contiguous runs, word-boundary hits, and shorter targets.
 */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  if (!q) return 0; // empty query matches everything equally
  const t = target.toLowerCase();
  let qi = 0, score = 0, streak = 0, prev = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    let b = 1;
    if (ti === prev + 1) { streak++; b += streak * 2; } else streak = 0; // contiguous run bonus
    const before = t[ti - 1];
    if (ti === 0 || before === "/" || before === "-" || before === "_" || before === ".") b += 3; // word boundary
    score += b;
    prev = ti;
    qi++;
  }
  if (qi < q.length) return -1; // ran out of target before matching the whole query
  return score - Math.floor(t.length / 40); // slight preference for shorter paths
}

/**
 * The active `@…` file-reference token at the cursor, or null. The `@` must start the input or follow
 * whitespace, and the query (between `@` and the cursor) must be whitespace-free.
 */
export function atToken(v: string, c: number): { start: number; query: string } | null {
  let i = c - 1;
  while (i >= 0 && v[i] !== "@" && !/\s/.test(v[i])) i--;
  if (i < 0 || v[i] !== "@") return null;
  if (i > 0 && !/\s/.test(v[i - 1])) return null; // '@' mid-word (e.g. an email) is not a trigger
  const query = v.slice(i + 1, c);
  if (/\s/.test(query)) return null;
  return { start: i, query };
}

/** Walks the project once → relative file paths (capped). Skips the same dirs as the glob tool. */
export async function listProjectFiles(root: string, cap = 4000): Promise<string[]> {
  const out: string[] = [];
  for await (const abs of walkFiles(root)) {
    out.push(relative(root, abs));
    if (out.length >= cap) break;
  }
  return out;
}

/** Ranks pre-listed files against a query, best first, up to `limit`. */
export function rankFiles(files: string[], query: string, limit = 8): string[] {
  const scored: { path: string; score: number }[] = [];
  for (const path of files) {
    const s = fuzzyScore(query, path);
    if (s >= 0) scored.push({ path, score: s });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((m) => m.path);
}
