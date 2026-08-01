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

/**
 * The composer's editing keys, as data.
 *
 * They were a chain of `if (s === "\x01")` tests inside the render file, and that is why the set was partial:
 * Ctrl+arrow word motion was bound but Alt+arrow — the macOS default, and what most people actually press —
 * was not, nor Alt+Backspace, nor deleting a word forwards; and Home/End jumped to the ends of the whole
 * buffer rather than of the line, which is not what any editor does in a multi-line field.
 *
 * A terminal reports the same key differently depending on itself, its settings, and whether Option is being
 * read as Meta or as an Escape prefix. So each action lists every form seen in the wild rather than one
 * canonical one: a key bound in only its rarest encoding is a key that silently does nothing.
 */
export interface Edit { value: string; cursor: number }

/** Where the cursor goes. The text is untouched. */
const MOTIONS: { keys: string[]; to: (v: string, c: number) => number }[] = [
  // Char — including the SS3 forms sent in application-cursor mode.
  { keys: ["\x1b[D", "\x1bOD"], to: (_v, c) => c - 1 },
  { keys: ["\x1b[C", "\x1bOC"], to: (v, c) => Math.min(v.length, c + 1) },
  // Word. `1;5` is Ctrl, `1;3` is Alt, `1;9` is iTerm2 with Option as Meta, and `\x1b\x1b[` is what a
  // terminal sends when it reports Option as an Escape prefix.
  { keys: ["\x1b[1;5D", "\x1b[1;3D", "\x1b[1;9D", "\x1b\x1b[D", "\x1b[5D", "\x1bb", "\x1bB"], to: wordLeft },
  { keys: ["\x1b[1;5C", "\x1b[1;3C", "\x1b[1;9C", "\x1b\x1b[C", "\x1b[5C", "\x1bf", "\x1bF"], to: wordRight },
  // Line: Home/End are per LINE, as in every editor. The ends of the whole buffer are the modified forms.
  { keys: ["\x01", "\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"], to: lineStart },
  { keys: ["\x05", "\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"], to: lineEnd },
  { keys: ["\x1b[1;5H", "\x1b[1;3H", "\x1b<"], to: () => 0 },
  { keys: ["\x1b[1;5F", "\x1b[1;3F", "\x1b>"], to: (v) => v.length },
];

/** Which span goes. The cursor lands where the span started. */
const DELETIONS: { keys: string[]; span: (v: string, c: number) => [number, number] }[] = [
  { keys: ["\x7f", "\x08"], span: (_v, c) => [Math.max(0, c - 1), c] },
  { keys: ["\x1b[3~"], span: (v, c) => [c, Math.min(v.length, c + 1)] },
  { keys: ["\x17", "\x1b\x7f", "\x1b\x08"], span: (v, c) => [wordLeft(v, c), c] },        // Ctrl+W · Alt+Backspace
  { keys: ["\x1bd", "\x1bD", "\x1b[3;5~", "\x1b[3;3~"], span: (v, c) => [c, wordRight(v, c)] }, // Alt+D · Alt+Del
  { keys: ["\x15"], span: (v, c) => [lineStart(v, c), c] },                               // Ctrl+U
  { keys: ["\x0b"], span: (v, c) => [c, lineEnd(v, c)] },                                 // Ctrl+K
];

const motionFor = new Map<string, (v: string, c: number) => number>();
for (const m of MOTIONS) for (const k of m.keys) motionFor.set(k, m.to);
const deletionFor = new Map<string, (v: string, c: number) => [number, number]>();
for (const d of DELETIONS) for (const k of d.keys) deletionFor.set(k, d.span);

/**
 * Applies an editing key. Returns undefined when the sequence is not one — the caller then handles it (a
 * submit, a palette key) or inserts it as text.
 */
export function applyKey(seq: string, value: string, cursor: number): Edit | undefined {
  const move = motionFor.get(seq);
  if (move) return { value, cursor: Math.max(0, Math.min(value.length, move(value, cursor))) };
  const span = deletionFor.get(seq);
  if (span) {
    const [from, to] = span(value, cursor);
    if (from === to) return { value, cursor };
    return { value: value.slice(0, from) + value.slice(to), cursor: from };
  }
  return undefined;
}

/** Every sequence the composer treats as an editing key — for tests and for the help overlay. */
export const EDIT_KEYS: readonly string[] = [...motionFor.keys(), ...deletionFor.keys()];
