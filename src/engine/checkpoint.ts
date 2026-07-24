import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** The spec-kit upstream phases a run may have completed, in order. */
export type UpstreamPhase = "constitution" | "spec" | "clarify" | "plan" | "tasks";

/**
 * A resume checkpoint written at a worktree's root (`<slug>/checkpoint.json`, OUTSIDE the git `base/` tree
 * so it is never committed). It records which upstream phases already finished so a re-run — even after
 * hcode is restarted — can reuse the preserved worktree and skip straight to the first unfinished phase.
 */
export interface Checkpoint {
  rawPrompt: string;   // the user's ORIGINAL prompt — the stable key a re-run is matched against
  refinedPrompt: string;
  title: string;
  featureSlug: string; // the specs/NNN-… dir to reuse (so resume doesn't create a fresh numbered feature)
  done: UpstreamPhase[];
}

function checkpointPath(worktreeRoot: string): string {
  return join(worktreeRoot, "checkpoint.json");
}

/** Normalize a prompt for matching: trim + collapse whitespace + lowercase (tolerant of retyping). */
export function checkpointKey(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").toLowerCase();
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
    writeFileSync(checkpointPath(worktreeRoot), JSON.stringify(cp, null, 2), "utf8");
  } catch { /* best-effort: a failed checkpoint write must never crash the pipeline */ }
}

/** Remove the checkpoint — called when the upstream reaches a terminal state (fully done or rejected). */
export function clearCheckpoint(worktreeRoot: string): void {
  try {
    rmSync(checkpointPath(worktreeRoot), { force: true });
  } catch { /* best-effort */ }
}
