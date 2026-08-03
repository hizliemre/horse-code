// The kitty keyboard protocol reports numpad keys as CSI-u functional codepoints (`\x1b[<cp>[;<mod>]u`)
// rather than plain characters — this is what iTerm2 sends once the protocol is enabled, so numpad
// digits and `/` never arrive as text. Map the numeric ones back to their characters.
const KITTY_NUMPAD: Record<number, string> = {
  57399: "0", 57400: "1", 57401: "2", 57402: "3", 57403: "4",
  57404: "5", 57405: "6", 57406: "7", 57407: "8", 57408: "9",
  57409: ".", 57410: "/", 57411: "*", 57412: "-", 57413: "+", 57415: "=", 57416: ",",
};
const KITTY_KP_ENTER = 57414;

export type KittyKey =
  | { type: "char"; char: string } // a numpad key that maps to a printable character
  | { type: "enter" }              // numpad Enter → submit
  | { type: "escape" }             // Esc (kitty reports it as \x1b[27u under flag 1)
  | { type: "other" }              // some other CSI-u functional key → caller should ignore it
  | undefined;                     // not a CSI-u sequence at all

/**
 * Parses a kitty-protocol CSI-u sequence (`\x1b[<cp>[;<mod>]u`). Returns the numpad character, Enter, or
 * Escape when applicable, "other" for any other functional CSI-u key (so callers can safely ignore it
 * instead of mis-handling it), or undefined when the input isn't a CSI-u sequence.
 */
export function parseKittyKey(s: string): KittyKey {
  const m = /^\x1b\[(\d+)(?:;\d+)?u$/.exec(s);
  if (!m) return undefined;
  const cp = Number(m[1]);
  if (cp === KITTY_KP_ENTER) return { type: "enter" };
  if (cp === 27) return { type: "escape" };
  const char = KITTY_NUMPAD[cp];
  if (char) return { type: "char", char };
  return { type: "other" };
}

/**
 * Ctrl+C, in both the forms a terminal sends it.
 *
 * Raw `\x03` normally; `CSI 99;5u` when the kitty keyboard protocol is on (what iTerm2 sends with it
 * enabled). Both were already handled inside the input line — this names them so App can claim the gesture
 * while a job is running, which is the one time the input line deliberately does not.
 */
export function isInterrupt(s: string): boolean {
  return s === "\x03" || s === "\x1b[99;5u";
}

/**
 * The keys that mean "put the clipboard's image here".
 *
 * NOT Cmd+V, and it cannot be: the terminal owns that chord, reads the clipboard itself, and writes the
 * result to stdin — and an image has no text form, so nothing is written and the application is never told
 * anything happened. There is no keystroke to hook.
 *
 * `\x16` (Ctrl+V) does arrive, in every terminal, with nothing to configure. Alt+V is kept for the people who
 * already have Option bound to Meta.
 */
export function isImagePaste(s: string): boolean {
  if (s === "\x16" || s === "\x1bv" || s === "\x1bV") return true;
  /**
   * …and the form it actually arrives in here.
   *
   * This TUI turns the kitty keyboard protocol on, and under it a MODIFIED key comes as a CSI-u sequence
   * instead of a control byte — which is why the raw byte alone did nothing while a key test outside the
   * program showed `0x16` arriving perfectly. The same thing was already known about Ctrl+C, handled as
   * `\x1b[99;5u` beside `\x03`; Ctrl+V simply had not been given its half.
   *
   * The modifier is a bitfield offset by one: shift 1, alt 2, ctrl 4. Ctrl or alt is what makes this a
   * command rather than the letter v, so an unmodified or shift-only "v" is left alone to be typed.
   */
  const m = /^\x1b\[118(?:;(\d+))?u$/.exec(s);
  if (!m) return false;
  const mods = Number(m[1] ?? 1) - 1;
  return (mods & 4) !== 0 || (mods & 2) !== 0;   // ctrl or alt
}
