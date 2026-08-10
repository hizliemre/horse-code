import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import type { Tool } from "../core/types.js";
import { unfinishedSessions } from "../engine/unfinished.js";

/**
 * Where the last run got to, for the role standing in the project root.
 *
 * A session's work lives in `.horsecode/worktrees/<id>/base` on its own branch, and the coach runs in the
 * project checkout. So "continue from where we left off" asked the coach about a directory it was not in:
 * measured live, a run stopped with 126 commits on its branch and the next session's coach answered "I could
 * not find a clear task trail from the last session — memory only has the constitution/language rule, no
 * active spec/plan/todo reference", then listed four unrelated pull requests and asked which was meant.
 *
 * It was reasoning correctly from what it could see. Everything it needed — the original request, which
 * phases finished, the board, the branch — was three directories away in files written for this purpose.
 *
 * The tool returns the WORKTREE PATH as well as the summary, because reading is how the coach follows up:
 * every file tool resolves an absolute path, so with the path it can open the spec, the plan and the board
 * itself rather than asking the user to describe them.
 */

const params = z.object({});

/** Commits a session branch has that the base does not. Best-effort: a missing branch simply counts zero. */
function commitsAhead(cwd: string, branch: string): number {
  try {
    const out = execFileSync("git", ["rev-list", "--count", `HEAD..${branch}`],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return Number(out.trim()) || 0;
  } catch { return 0; }
}

export const findUnfinishedTool: Tool = {
  name: "find_unfinished",
  description:
    "Lists work a previous run left behind in this project, newest first: what the user originally asked, "
    + "which pipeline phases finished, how many board tasks are done, how many commits sit on the session's "
    + "branch, and the absolute path of its worktree. Call it whenever the user refers to earlier work — "
    + "\"continue\", \"where were we\", \"what was I doing\" — before answering from the repository, because "
    + "a session's work is NOT in the checkout you are standing in: it is on its own branch in its own "
    + "worktree. Read files under the worktree path to see the spec, plan or board it produced.",
  permissionLevel: "safe",
  parameters: params,
  describe: () => ({ allowKey: "find_unfinished", preview: "find unfinished work" }),
  run: async (_args, ctx) => {
    const found = unfinishedSessions(ctx.cwd, (b) => commitsAhead(ctx.cwd, b));
    if (!found.length) {
      return {
        content: "No unfinished session in this project: every worktree has either been cleaned up or never "
          + "recorded a checkpoint. Anything earlier is in the repository's own history.",
        isError: false,
      };
    }
    const rows = found.map((s) => {
      const c = s.checkpoint;
      return [
        `## ${s.id}`,
        `- The user asked: "${c.rawPrompt.trim() || c.title}"`,
        `- Understood as: ${c.refinedPrompt}`,
        `- Phases finished: ${c.done.length ? c.done.join(" → ") : "none"}${c.lane ? ` (lane: ${c.lane})` : ""}`,
        s.cards.total ? `- Tasks: ${s.cards.done} of ${s.cards.total} finished` : "- No task board yet",
        `- Branch \`hc/${s.id}/base\` has ${s.commits} commit(s) the base does not`,
        `- Worktree: ${join(ctx.cwd, ".horsecode", "worktrees", s.id, "base")}`,
      ].join("\n");
    });
    return {
      content: `${rows.join("\n\n")}\n\nTo continue one of these, the user says **continue** — that reopens the `
        + `session and its lane. You can read anything under the worktree path above to answer questions `
        + `about it now.`,
      isError: false,
    };
  },
};
