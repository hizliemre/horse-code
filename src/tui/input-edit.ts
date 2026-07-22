// Readline-style word/line motion for the composer (whitespace-delimited words; a "line" is bounded by \n).
const isWS = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\n";

/** Index at the start of the word before the cursor (skips trailing spaces, then the word). */
export function wordLeft(v: string, c: number): number {
  let i = c;
  while (i > 0 && isWS(v[i - 1])) i--;
  while (i > 0 && !isWS(v[i - 1])) i--;
  return i;
}

/** Index at the end of the word after the cursor (skips leading spaces, then the word). */
export function wordRight(v: string, c: number): number {
  let i = c;
  while (i < v.length && isWS(v[i])) i++;
  while (i < v.length && !isWS(v[i])) i++;
  return i;
}

/** Index of the first char on the cursor's line (after the previous newline, or 0). */
export const lineStart = (v: string, c: number): number => v.lastIndexOf("\n", c - 1) + 1;

/** Index just before the next newline at/after the cursor (or the end of the input). */
export const lineEnd = (v: string, c: number): number => {
  const nl = v.indexOf("\n", c);
  return nl === -1 ? v.length : nl;
};
