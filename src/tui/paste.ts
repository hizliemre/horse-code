// Bracketed-paste handling: large/multi-line pastes are collapsed to a placeholder token in the composer
// (so a 500-line paste doesn't take over the input), then expanded back to the full text on submit.

export const PASTE_COLLAPSE_CHARS = 200;
export const PASTE_COLLAPSE_LINES = 3;

/** Collapse a paste to a placeholder when it's large or spans several lines; small pastes go in verbatim. */
export function shouldCollapsePaste(text: string): boolean {
  const newlines = text.match(/\n/g)?.length ?? 0;
  return text.length > PASTE_COLLAPSE_CHARS || newlines >= PASTE_COLLAPSE_LINES;
}

/** The visible placeholder for a collapsed paste (carries the id used to expand it later). */
export function pasteToken(id: number, text: string): string {
  const lines = text.split("\n").length;
  return `⟨paste #${id}: ${lines} line${lines === 1 ? "" : "s"}⟩`;
}

const TOKEN_RE = /⟨paste #(\d+): \d+ lines?⟩/g;

/** Replaces every ⟨paste #N⟩ placeholder with its stored full text (unknown ids are left as-is). */
export function expandPasteTokens(text: string, map: Map<number, string>): string {
  return text.replace(TOKEN_RE, (m, n) => map.get(Number(n)) ?? m);
}

/**
 * The placeholder for a pasted IMAGE.
 *
 * A count under the input ("2 images staged") was all there was, and it is not the same thing: it does not
 * say where in the sentence the picture belongs, and it leaves nothing behind in the transcript. Reported
 * from a live run — "yapıştırdığıma dair bir ibare göremiyorum" — and the shape asked for is this one.
 *
 * Deliberately unlike the text placeholder: the two share a composer, and a person retyping one must not
 * silently produce the other.
 */
export function imageToken(id: number): string {
  return `[Pasted Image #${id}]`;
}

const IMAGE_TOKEN_RE = /\[Pasted Image #(\d+)\]/g;

/**
 * Replaces every image placeholder with the PATH the image was written to.
 *
 * A path, not the bytes: everything downstream that can carry a picture already resolves a named file — the
 * inbox note that reaches a running agent, the request that starts a verification. Expanding to a path makes
 * the composer's shorthand work through all of them without any of them knowing about the composer.
 */
export function expandImageTokens(text: string, map: Map<number, string>): string {
  return text.replace(IMAGE_TOKEN_RE, (m, n) => map.get(Number(n)) ?? m);
}
