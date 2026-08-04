import { dirname, join, resolve, sep } from "node:path";

/**
 * Which session a working directory belongs to.
 *
 * Agents do not run in the project. They run in a task worktree under `.horsecode/worktrees/<job>/tasks/…`,
 * and the project's own state — the graph, the memory, the traces, the constitution — is not there.
 *
 * The fix is NOT to read it from the project root. The root is a reference: anything written there never
 * reaches the pull request this run exists to produce, so a lesson learned by a task would be saved into a
 * file nobody reviews and nobody receives. Everything a run reads or writes has to live inside the session,
 * where it is committed and delivered with the work.
 *
 * So a task worktree resolves upward to its SESSION BASE and stops there. The path says which session it is
 * — `<project>/.horsecode/worktrees/<job>/tasks/<task>` — so this is structural, not a filesystem guess.
 */
export const HC_DIR = ".horsecode";
const WORKTREES = join(HC_DIR, "worktrees");
const BASE = "base";

/**
 * The base worktree of the session `cwd` belongs to, or undefined when it belongs to none.
 *
 * Undefined is the honest answer for the project root itself and for anywhere outside a session: the caller
 * then works with what it was given rather than reaching for state that is not its own.
 */
export function sessionBase(cwd: string): string | undefined {
  const abs = resolve(cwd);
  const marker = `${sep}${WORKTREES}${sep}`;
  const at = abs.indexOf(marker);
  if (at < 0) return undefined;
  const after = abs.slice(at + marker.length);
  const job = after.split(sep)[0];
  if (!job) return undefined;
  return join(abs.slice(0, at), WORKTREES, job, BASE);
}

/**
 * The directory a run should read its project state from: the session base when there is one, otherwise the
 * caller's own directory (the REPL itself, running at the project root).
 */
export function stateRoot(cwd: string): string {
  return sessionBase(cwd) ?? resolve(cwd);
}

/**
 * Where a run may write SHARED project state — or undefined when it is not in a session.
 *
 * `stateRoot` falls back to the cwd when there is no session, and that fallback is how the root got written
 * to. Measured on a real project checkout: `.horsecode/memory.jsonl`, `graphify-out/graph.json`,
 * `graphify-out/.graphify_labels.json` and `docs/architecture/index.json` all left modified and uncommitted
 * — four files that both sides of every merge regenerate, so every pull afterwards refused to apply.
 *
 * The rule was already written down, on `isSessionBase` below: "the one place a run may write project
 * state". It had no callers. A rule nobody calls is a comment.
 *
 * Machine-local state (`last-turn.json`, `config.json`) still belongs at the root and still uses
 * `stateRoot` — it is git-ignored there, so it never reaches a merge.
 */
export function writableStateRoot(cwd: string): string | undefined {
  return sessionBase(cwd);
}

/** True when this directory IS a session base — the one place a run may write project state. */
export function isSessionBase(cwd: string): boolean {
  const abs = resolve(cwd);
  return abs.endsWith(`${sep}${BASE}`) && sessionBase(abs) === abs;
}

/** The job slug of the session a directory belongs to — for notes that name which run wrote something. */
export function sessionSlug(cwd: string): string | undefined {
  const base = sessionBase(cwd);
  return base ? dirname(base).split(sep).pop() : undefined;
}
