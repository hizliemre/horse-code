/**
 * Text that survives being cut, and being sent.
 *
 * JavaScript strings are UTF-16, and a character outside the Basic Multilingual Plane — an emoji, a rarer CJK
 * glyph, a mathematical symbol — is stored as a PAIR of code units. `String.prototype.slice` counts code
 * units, so a cut that lands between the two halves leaves a lone surrogate: a value that is a valid
 * JavaScript string and is not valid text. `JSON.stringify` encodes it happily, the server decodes it and
 * refuses the whole request.
 *
 * Measured: a run of 279 minutes, 303 calls and 7.1M tokens ended with
 * `[400]: The request body is not valid JSON: invalid high surrogate in string: line 1 column 79060` — after
 * a turn that had just elided an oversized grep result and put away 26k characters of earlier tool output.
 * Both of those cut by code unit, on tool output that is arbitrary bytes from a real repository.
 *
 * Two functions, because there are two jobs: stop producing lone surrogates when cutting, and refuse to send
 * one whatever produced it.
 */

/** A high surrogate with no low after it, or a low surrogate with no high before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** What replaces a half-character. U+FFFD is what every decoder already substitutes for exactly this. */
export const REPLACEMENT = "�";

/**
 * Removes surrogate halves that lost their partner.
 *
 * Applied at the point of SENDING, where it cannot be forgotten: the same reasoning as the secret redactor —
 * there is one socket and there are dozens of places that build what goes through it, and the one that gets
 * missed is the one that ends a four-hour run.
 */
export function stripLoneSurrogates(text: string): string {
  // Fast path: the check is a scan, the rewrite is an allocation, and virtually every string is already fine.
  LONE_SURROGATE.lastIndex = 0;
  return LONE_SURROGATE.test(text) ? text.replace(LONE_SURROGATE, REPLACEMENT) : text;
}

/** Every string in a request body, made sendable — including nested tool schemas and tool-call arguments. */
export function sanitizeForJson<T>(value: T): T {
  if (typeof value === "string") return stripLoneSurrogates(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeForJson(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitizeForJson(v);
    return out as unknown as T;
  }
  return value;
}

/**
 * `slice(0, n)` that never splits a character.
 *
 * Backs off by one when the cut would land between a high surrogate and its low half. One character shorter
 * than asked for is not a limit anyone notices; half a character is a request the server rejects.
 */
export function truncateSafe(text: string, max: number): string {
  if (text.length <= max || max <= 0) return text;
  const code = text.charCodeAt(max - 1);
  // A high surrogate at the last kept position means its partner is the first dropped one.
  const end = code >= 0xD800 && code <= 0xDBFF ? max - 1 : max;
  return text.slice(0, end);
}
