import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readCheckpoint } from "./checkpoint.js";
import type { Checkpoint } from "./checkpoint.js";

/**
 * Work a previous run left behind, said out loud at start-up.
 *
 * Every piece of this was already on disk and none of it was read out. A session writes a checkpoint — the
 * original request, the refined one, the language, which phases finished — and a board with its tasks, and a
 * worktree holding the commits. Reported live: a run stopped with 126 commits on its branch, and the next
 * session's coach, standing in the project root, answered "I could not find a clear task trail from the last
 * session — memory only has the constitution/language rule, no active spec/plan/todo reference", then asked
 * the user which of several open pull requests they had meant.
 *
 * It was not wrong. It was looking at the repository, and the answer was in `.horsecode/worktrees/…`, three
 * directories away, in a file written for exactly this purpose.
 */

/** A session that still has a worktree and a checkpoint — i.e. something to go back to. */
export interface Unfinished {
  /** The session directory's name, which is also what `/sessions` and the branch are named after. */
  id: string;
  checkpoint: Checkpoint;
  /** Board cards by column, when the session got as far as a board. */
  cards: { total: number; done: number };
  /** Commits on the session branch that the base does not have — the work itself. */
  commits: number;
  updatedAt: number;
}

/** Reads the board without importing it: this runs at start-up and must not pull the engine in behind it. */
function boardCounts(dir: string): { total: number; done: number } {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "board.json"), "utf8")) as { cards?: unknown };
    const cards = Array.isArray(raw.cards) ? raw.cards : Object.values(raw.cards ?? {});
    const list = cards as { column?: string }[];
    return { total: list.length, done: list.filter((c) => c.column === "MERGED" || c.column === "DONE").length };
  } catch {
    return { total: 0, done: 0 };
  }
}

/**
 * Sessions in this project that were left with work in them, newest first.
 *
 * A session with no checkpoint is one that never started anything; a session whose worktree is gone has
 * nothing to return to. Both are silently skipped — what is worth saying is only the case where continuing
 * is actually possible.
 */
export function unfinishedSessions(
  cwd: string,
  commitCount: (branch: string) => number = () => 0,
): Unfinished[] {
  const root = join(cwd, ".horsecode", "worktrees");
  if (!existsSync(root)) return [];
  const out: Unfinished[] = [];
  for (const id of readdirSync(root)) {
    const dir = join(root, id);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    if (!existsSync(join(dir, "base"))) continue;          // the worktree is gone → nothing to go back to
    const checkpoint = readCheckpoint(dir);
    if (!checkpoint) continue;                             // never got far enough to record anything
    let updatedAt = 0;
    try { updatedAt = statSync(join(dir, "checkpoint.json")).mtimeMs; } catch { /* order it last */ }
    out.push({
      id, checkpoint, cards: boardCounts(dir),
      commits: commitCount(`hc/${id}/base`), updatedAt,
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * One line per session, for the start-up summary.
 *
 * The REQUEST in the user's own words, because that is what they will recognise — the refined prompt is the
 * pipeline's working English and the slug is a filename. Then what exists of it: how far the phases got, how
 * many tasks are finished, how many commits are on the branch.
 */
export function describeUnfinished(s: Unfinished): string {
  const asked = s.checkpoint.rawPrompt.trim() || s.checkpoint.title;
  const bits = [
    s.checkpoint.done.length ? `${s.checkpoint.done.join(" → ")} done` : "nothing finished yet",
    s.cards.total ? `${s.cards.done}/${s.cards.total} tasks` : "",
    s.commits ? `${s.commits} commit${s.commits === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return `“${asked.length > 70 ? `${asked.slice(0, 69)}…` : asked}” — ${bits.join(" · ")} `
    + `(\`${s.id}\`; say **continue** to pick it up)`;
}
