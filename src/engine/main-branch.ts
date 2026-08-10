import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { patchConfig } from "../config/patch.js";

/**
 * Which branch is this project's main one.
 *
 * A resumed session has to merge it in before it continues — its own branch was cut days ago and everything
 * the team landed since is missing from it. So the name has to be known, and it cannot be guessed: `main`,
 * `master`, `develop` and `development` are all in use, and the branch that happens to be checked out is
 * whatever the user was last looking at, not the project's trunk.
 *
 * The order is: what the project already recorded → what git can prove → ask the user, once, and record it.
 * "Once" is the whole point of the last step, so the answer is written before it is returned.
 */

export type GitRun = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** The branch names worth offering when git cannot prove which one it is. */
export const COMMON_MAIN_BRANCHES = ["main", "master", "development", "develop", "trunk"];

/** Reads the project's own config. Not the merged one: this is a fact about THIS repository. */
export async function recordedMainBranch(cwd: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(cwd, ".horsecode", "config.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const v = (parsed as Record<string, unknown>).mainBranch;
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined; // no config, unreadable, or not JSON → nothing recorded
  }
}

/** Writes it back, so the question is asked once and never again. Best-effort, like every other save. */
export async function saveMainBranch(cwd: string, branch: string): Promise<boolean> {
  // `patchConfig` names its first parameter `home` because that is its usual caller; what it actually does is
  // patch `<dir>/.horsecode/config.json` atomically, which is exactly what a per-project setting needs.
  return patchConfig(cwd, (current) => ({ ...current, mainBranch: branch }));
}

/**
 * What git can prove on its own.
 *
 * `origin/HEAD` is the remote's declared default branch and the only authoritative answer available locally.
 * When it is unset — which is common, since a plain `git clone` sets it but plenty of repositories are set up
 * other ways — this returns nothing rather than guessing, because guessing wrong means merging the wrong
 * branch into the user's work.
 */
export async function detectMainBranch(cwd: string, git: GitRun): Promise<string | undefined> {
  const r = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  if (r.code !== 0) return undefined;
  const name = r.stdout.trim().replace(/^origin\//, "");
  return name || undefined;
}

/** Branches the remote actually has, used to order the choices offered to the user. */
async function remoteBranches(cwd: string, git: GitRun): Promise<string[]> {
  const r = await git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], cwd);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((s) => s.trim().replace(/^origin\//, "")).filter((s) => s && s !== "HEAD");
}

/**
 * The choices to offer: the conventional names this repository actually has, then everything else it has.
 *
 * Offering names that do not exist would let the user pick a branch the merge then fails on, and offering
 * three hundred feature branches would bury the answer. `current` is excluded — the question is which branch
 * the work comes FROM, and the session's own branch is never that.
 */
export function mainBranchChoices(remote: string[], current?: string): string[] {
  // `hc/<session>/…` are horse-code's own session branches. Offering one as the project's trunk would ask a
  // resumed session to sync from itself — and on a real project they outnumbered everything else on the list.
  const have = remote.filter((b) => b !== current && !b.startsWith("hc/"));
  const common = COMMON_MAIN_BRANCHES.filter((b) => have.includes(b));
  const rest = have.filter((b) => !common.includes(b));
  return [...common, ...rest].slice(0, 8);
}

/** Asked at most once per project, so it can afford to say why it is being asked. */
export const MAIN_BRANCH_QUESTION =
  "Which branch is this project's main one? I sync it into the session branch before continuing, so the "
  + "work carries on against current code. I'll remember the answer and won't ask again.";

export interface MainBranchDeps {
  cwd: string;
  git: GitRun;
  askUser: (question: string, opts?: { options?: string[] }) => Promise<string>;
  note?: (text: string) => void;
  /**
   * Puts the question into the language the user is working in. Absent = ask it as written.
   *
   * This module holds no model plumbing on purpose: what it knows is which branch a project builds from, and
   * a caller that can phrase things supplies the phrasing. See src/engine/user-language.ts.
   */
  phrase?: (text: string) => Promise<string>;
}

/**
 * The recorded name, or git's proof, or the user's answer — and after the user's answer, the recorded name.
 *
 * Returns undefined only when there is nothing to sync from: a repository with no remote and no answer.
 */
export async function resolveMainBranch(deps: MainBranchDeps): Promise<string | undefined> {
  const recorded = await recordedMainBranch(deps.cwd);
  if (recorded) return recorded;

  const detected = await detectMainBranch(deps.cwd, deps.git);
  if (detected) {
    // Proven, not guessed — worth recording so the detection never has to be trusted twice.
    await saveMainBranch(deps.cwd, detected);
    deps.note?.(`🌿 Main branch: \`${detected}\` (from \`origin/HEAD\`) — remembered for this project.`);
    return detected;
  }

  const choices = mainBranchChoices(await remoteBranches(deps.cwd, deps.git));
  const answer = (await deps.askUser(
    await (deps.phrase ?? ((t: string) => Promise.resolve(t)))(MAIN_BRANCH_QUESTION),
    choices.length ? { options: choices } : undefined,
  )).trim();
  if (!answer) return undefined;
  await saveMainBranch(deps.cwd, answer);
  deps.note?.(`🌿 Main branch: \`${answer}\` — remembered for this project.`);
  return answer;
}
