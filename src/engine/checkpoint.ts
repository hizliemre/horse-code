import { existsSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeAtomicSync } from "../session/atomic.js";

/** The spec-kit upstream phases a run may have completed, in order. */
export type UpstreamPhase = "constitution" | "brainstorm" | "spec" | "clarify" | "plan" | "tasks";

/**
 * A resume checkpoint written at a worktree's root (`<slug>/checkpoint.json`, OUTSIDE the git `base/` tree
 * so it is never committed). It records which upstream phases already finished so a re-run — even after
 * hcode is restarted — can reuse the preserved worktree and skip straight to the first unfinished phase.
 * It also carries everything a resume needs WITHOUT re-running the refiner (refinedPrompt/title/language),
 * so a bare "continue" request can pick the work back up directly.
 */
export interface Checkpoint {
  rawPrompt: string;   // the user's ORIGINAL prompt — the stable key an exact re-run is matched against
  refinedPrompt: string;
  title: string;
  language: string;    // the user's language (English name, e.g. "Turkish") → review/escalation localization
  featureSlug: string; // the specs/NNN-… dir to reuse (so resume doesn't create a fresh numbered feature)
  done: UpstreamPhase[];
  /** Deferred (non-blocking) findings accumulated so far — they must survive a restart or the later stages
   *  would never see what earlier reviews chose not to block on. */
  carryOver?: string[];
}

function checkpointPath(worktreeRoot: string): string {
  return join(worktreeRoot, "checkpoint.json");
}

/** Normalize a prompt for matching: trim + collapse whitespace + lowercase (tolerant of retyping). */
export function checkpointKey(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The words a continuation is MADE of — the verb, its inflections, and the padding people put around it.
 *
 * Not a stopword list in general: every entry is here because it can appear in "just carry on" and carries no
 * subject of its own. Turkish inflects the verb and English spreads it over several words, so both are
 * enumerated rather than guessed at.
 */
const CONTINUE_FILLER = new Set([
  // Turkish: devam + its inflections, "where we left off", and the usual padding.
  "devam", "et", "et.", "edelim", "edin", "ediyoruz", "edeceğiz", "edecegiz", "edeceksin", "ettik", "edeyim",
  "kaldığımız", "kaldigimiz", "kaldığın", "kaldigin", "kaldığı", "kaldigi", "kaldık", "kaldik", "yerden",
  "hadi", "lütfen", "lutfen", "tamam", "bakalım", "bakalim", "artık", "artik", "mi", "mı", "mu", "mü",
  // English.
  "continue", "resume", "carry", "on", "keep", "going", "pick", "up", "where", "from", "we", "left", "off",
  "let's", "lets", "us", "please", "ok", "okay", "just", "the", "it", "you", "i", "and", "then", "now",
]);

/** The word that makes it a continuation at all — without one of these, nothing else matters. */
const CONTINUE_VERB = /(^|\s)(devam|kald[ıi]\w*|continue|resume|carry on|keep going|pick up (where|from))(\s|$|[.,!?])/i;

/**
 * Is this a bare "continue where we left off" request (rather than a fresh task)? Such a prompt should resume
 * the most recently touched preserved worktree — the user must NOT have to retype the exact original request.
 *
 * The test used to be length: under sixty characters and containing the word meant "resume". That was wrong in
 * the language it was written for. Turkish puts the continuation verb at the END, so naming a subject in front
 * of it — "ürün yaratma sihirbazının testlerine devam edeceğiz" — stays well inside sixty characters, and a
 * real request was answered with "there is no preserved work to continue" without ever reaching intent
 * classification.
 *
 * The distinction was never length. It is whether the sentence says anything BESIDES continuing: strip the
 * continuation vocabulary and the padding, and a bare continue has nothing left. One leftover word is still
 * bare ("devam et bakalım"); two is a subject, and a subject is a request.
 */
export function isContinuePrompt(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 200) return false;  // an essay is a request, whatever words it contains
  if (!CONTINUE_VERB.test(t)) return false;
  const rest = t.toLowerCase()
    .split(/[\s,.!?;:]+/)
    .filter(Boolean)
    .filter((w) => !CONTINUE_FILLER.has(w));
  return rest.length <= 1;
}

/** Last-modified time (ms) of a worktree's checkpoint, or 0 if none — used to pick the most recent to resume. */
export function checkpointMtime(worktreeRoot: string): number {
  try { return statSync(checkpointPath(worktreeRoot)).mtimeMs; } catch { return 0; }
}

export function readCheckpoint(worktreeRoot: string): Checkpoint | null {
  const p = checkpointPath(worktreeRoot);
  if (!existsSync(p)) return null;
  try {
    const cp = JSON.parse(readFileSync(p, "utf8")) as Checkpoint;
    if (!Array.isArray(cp.done)) return null;
    return cp;
  } catch {
    return null; // corrupt checkpoint → behave as if there is none (start fresh)
  }
}

export function writeCheckpoint(worktreeRoot: string, cp: Checkpoint): void {
  try {
    // Atomic: a half-written checkpoint makes a resume rerun phases that already cost real money.
    writeAtomicSync(checkpointPath(worktreeRoot), JSON.stringify(cp, null, 2));
  } catch { /* best-effort: a failed checkpoint write must never crash the pipeline */ }
}

/** Remove the checkpoint — called when the upstream reaches a terminal state (fully done or rejected). */
export function clearCheckpoint(worktreeRoot: string): void {
  try {
    rmSync(checkpointPath(worktreeRoot), { force: true });
  } catch { /* best-effort */ }
}
