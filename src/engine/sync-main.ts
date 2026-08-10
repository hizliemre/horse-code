import type { WorktreeManager, WorktreeSession } from "../worktree/manager.js";
import type { ConflictDeps } from "./conflict.js";
import { resolveGeneratedConflicts, runConflictResolver, hasConflictMarkers } from "./conflict.js";
import { resolveMainBranch, type GitRun } from "./main-branch.js";
import { inUserLanguage } from "./user-language.js";

/**
 * Bringing the project's main branch INTO a resumed session, before the session does anything else.
 *
 * A session branch is cut once and then lived on for days. Everything the team merges in the meantime is
 * absent from it, so a resumed run reads, edits and reviews code that no longer exists in the project — and
 * the first anyone learns of it is the pull request, where the whole divergence arrives at once as somebody
 * else's problem. Measured on a real project: a session resumed with 126 commits of its own, against a main
 * branch that had moved on underneath it the entire time.
 *
 * So the sync happens at the moment of resuming, not at the moment of merging back: the cost of a conflict is
 * lowest when the work that has to absorb it has not been done yet.
 *
 * Failure is never fatal here. A repository with no remote, a fetch that cannot reach the network, a merge
 * that will not resolve — each of those means the session continues on the code it already had, which is
 * exactly where it would have been without this. What must not happen is a resume that refuses to resume.
 */

export interface SyncDeps extends ConflictDeps {
  manager: ConflictDeps["manager"]
    & Pick<WorktreeManager, "mergeRef" | "fetchBranch" | "containsRef" | "commitsBehind" | "projectRoot">;
}

export type SyncResult =
  /** Already contains the main branch — nothing was merged, and nothing is worth saying. */
  | { status: "current"; branch: string }
  /** Main was merged in; `commits` is what it brought. */
  | { status: "synced"; branch: string; commits: number; conflicts: string[] }
  /** Conflicts the resolver could not settle → merge aborted, the session continues where it was. */
  | { status: "conflicted"; branch: string; files: string[] }
  /** No main branch to sync from, or git would not do it. `why` is what to tell the user. */
  | { status: "skipped"; why: string };

/** Rounds of resolution before a conflicted sync is given up on. Deliberately small — see `abandoned` below. */
export const SYNC_RESOLVE_ROUNDS = 2;

export async function syncMainBranch(
  deps: SyncDeps,
  session: WorktreeSession,
  opts: {
    git: GitRun;
    askUser: (question: string, o?: { options?: string[] }) => Promise<string>;
    /** The language this session is being run in — the checkpoint records it. See user-language.ts. */
    language?: string;
  },
): Promise<SyncResult> {
  const branch = await resolveMainBranch({
    cwd: deps.manager.projectRoot,
    git: opts.git,
    askUser: opts.askUser,
    phrase: (t: string) => inUserLanguage(deps, t, opts.language),
    ...(deps.note ? { note: deps.note } : {}),
  });
  if (!branch) return { status: "skipped", why: "no main branch is set for this project" };

  const ref = await deps.manager.fetchBranch(branch);
  if (await deps.manager.containsRef(session, ref)) return { status: "current", branch };
  const commits = await deps.manager.commitsBehind(session, ref);

  let merge;
  try {
    merge = await deps.manager.mergeRef(session, ref);
  } catch (e) {
    // A dirty worktree, an unknown ref, a merge already in progress — all of them mean "not now", none of
    // them mean "stop". The session's own code is untouched.
    const why = e instanceof Error ? e.message.split("\n")[0]! : String(e);
    deps.note?.(`⚠ Could not sync \`${branch}\` into this session (${why}) — continuing on the branch as it is.`);
    return { status: "skipped", why };
  }

  if (merge.status === "merged") {
    deps.note?.(`🔄 Synced \`${ref}\` into the session branch — ${commits} commit(s) brought in.`);
    return { status: "synced", branch, commits, conflicts: [] };
  }

  /**
   * Conflicts, resolved the same way a task's conflicts are: generated files settled deterministically, the
   * rest handed to the operational agent with the hunks already read out.
   *
   * What is deliberately NOT here is the per-task code-reviewer. That gate exists to judge whether a task's
   * deliverable is right; this merge has no deliverable — it is the project's own code arriving. The check
   * that matters is the deterministic one (no markers left), and everything merged here is about to be read,
   * edited and reviewed by the session that asked for it.
   */
  const { conflicted } = await resolveGeneratedConflicts(deps, session, merge.files);
  if (!conflicted.length) {
    await deps.manager.commitMerge(session, `chore: sync ${branch} into session branch`);
    deps.note?.(`🔄 Synced \`${ref}\` — ${commits} commit(s); generated files re-derived rather than merged.`);
    return { status: "synced", branch, commits, conflicts: merge.files };
  }

  deps.note?.(`🔀 Syncing \`${ref}\` conflicts in ${conflicted.join(", ")} — operational resolving…`);
  for (let round = 0; round < SYNC_RESOLVE_ROUNDS; round++) {
    const notes = round === 0 ? "" : `\nThe last attempt left conflict markers in: ${conflicted.join(", ")}`;
    await runConflictResolver(deps, session.baseWorktree, conflicted, notes);
    if (await hasConflictMarkers(session.baseWorktree, conflicted)) continue;
    await deps.manager.commitMerge(session, `chore: resolve conflicts syncing ${branch} into session branch`);
    deps.note?.(`🔄 Synced \`${ref}\` — ${commits} commit(s), ${conflicted.length} conflict(s) resolved.`);
    return { status: "synced", branch, commits, conflicts: merge.files };
  }

  /**
   * Abandoned, and abandoned cheaply.
   *
   * The alternative — asking the user to resolve it by hand before their work can continue — turns "continue
   * where we left off" into a merge session. The branch is exactly where it was, the user is told which files
   * it was, and they can sync it themselves at a moment of their choosing.
   */
  await deps.manager.abortMerge(session);
  deps.note?.(`⚠ Could not merge \`${ref}\` cleanly (${conflicted.join(", ")}) — the sync was rolled back and `
    + `the session continues on its own branch. Merge it by hand when you want those changes.`);
  return { status: "conflicted", branch, files: conflicted };
}
