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
