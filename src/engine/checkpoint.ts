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
 * Is this a bare "continue where we left off" request (rather than a fresh task)? Such a prompt should resume
 * the most recently touched preserved worktree — the user must NOT have to retype the exact original request.
 * Kept short-only to avoid mistaking a real task that merely mentions "resume/continue" for a continuation.
 */
export function isContinuePrompt(text: string): boolean {
  const t = text.trim();
  if (t.length > 60) return false; // a long prompt is a real new request, not a bare "continue"
  return /(^|\s)(devam|kald[ıi]\w*|continue|resume|carry on|keep going|pick up (where|from))(\s|$|\.|,|!)/i.test(t);
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
