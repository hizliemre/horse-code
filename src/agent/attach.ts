import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Handing over a screenshot.
 *
 * The provider has always been able to send images and a message has always been able to carry them; what was
 * missing was any way for the person at the keyboard to hand one over. The staging function existed and was
 * called from nowhere — and wiring it to a paste would not have helped, because a terminal does not put image
 * bytes on stdin. At best it pastes a file name.
 *
 * So the file name is the mechanism. Name the screenshot in the sentence and it comes along with it, which is
 * what a person does anyway: "the wizard's third step looks like ~/Desktop/shot.png".
 *
 * This matters most where a result depends on what a screen showed. A verification records evidence, and
 * "the developer said it looked right" is weaker than the picture they were looking at.
 */

const IMAGE_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};

/** Big enough for any screenshot, small enough that a message never becomes a file transfer. */
export const MAX_IMAGE_BYTES = 5_000_000;

/**
 * Candidate paths in a sentence.
 *
 * Anchored on a path-like START (`/`, `./`, `~/`, a bare `word/`) and allowed to run through SPACES up to an
 * image extension, because that is what a real screenshot is called: macOS writes "Ekran Resmi 2026-08-03
 * saat 14.32.10.png". Splitting on whitespace would find none of them.
 *
 * Greedy matching is safe here only because existence on disk is what actually decides — a sentence that
 * mentions a png does not carry one.
 */
const CANDIDATE = /(?:"([^"\n]+?\.(?:png|jpe?g|gif|webp))"|'([^'\n]+?\.(?:png|jpe?g|gif|webp))'|((?:~|\.{0,2}\/|[A-Za-z0-9_.-]+\/)[^\n"'`]*?\.(?:png|jpe?g|gif|webp)))/gi;

function expand(p: string, cwd: string): string {
  const t = p.trim();
  if (t.startsWith("~/")) return resolve(homedir(), t.slice(2));
  return isAbsolute(t) ? t : resolve(cwd, t);
}

/**
 * The images a message names, as data URIs, in the order they appear.
 *
 * Anything that is not a readable image of a sane size is skipped in silence: the alternative is a provider
 * error in the middle of a scenario, over a file the sentence merely mentioned.
 */
export function attachedImages(text: string, cwd: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CANDIDATE)) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (!raw) continue;
    // A URL is not a path — its "//" would otherwise read as a directory boundary.
    if (/^[a-z]+:\/\//i.test(raw)) continue;
    const abs = expand(raw, cwd);
    if (seen.has(abs)) continue;
    const ext = abs.slice(abs.lastIndexOf(".") + 1).toLowerCase();
    const mime = IMAGE_EXT[ext];
    if (!mime) continue;
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > MAX_IMAGE_BYTES || st.size === 0) continue;
      out.push(`data:${mime};base64,${readFileSync(abs).toString("base64")}`);
      seen.add(abs);
    } catch { /* named but not there — the sentence mentioned it, it does not carry it */ }
  }
  return out;
}
