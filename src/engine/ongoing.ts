import { join } from "node:path";
import { surveySessions } from "../worktree/clean.js";
import { readCheckpoint, checkpointMtime } from "./checkpoint.js";
import { askInUserLanguage, type Choice } from "./user-language.js";
import type { GitRunner } from "../worktree/git.js";
import type { AskUser, ReviewDeps } from "./review.js";

/**
 * Work that is already open somewhere, offered to the person who has to decide about it.
 *
 * A session is not a fresh start. Measured live: a project had one worktree carrying a half-finished
 * verification, and a new request — a one-line fix to the same wizard that verification was testing — was
 * sized "small" and done in the developer's own tree, on the branch their team shares. Nothing was wrong with
 * the sizing. What was missing was the question: there is work open over here, is this part of it?
 *
 * Automatic matching cannot answer that. `findResumable` compares the request against the checkpoint's
 * original prompt, so it finds preserved work only when the words happen to line up — and the second request
 * about one piece of work is almost never phrased like the first. The developer knows; the string comparison
 * does not.
 *
 * So the answer is asked for, every time there is anything unfinished — including when there is exactly one,
 * because "carry on there" and "leave that and open a new one" are both ordinary things to want.
 */

export interface Ongoing {
  slug: string;
  /** `.horsecode/worktrees/<slug>` — where the checkpoint lives, one level above the git tree. */
  root: string;
  /** `<root>/base` — the working tree itself. */
  baseWorktree: string;
  baseBranch: string;
  /** One short sentence: what is being worked on there. */
  what: string;
  /** How it stands against the project's main branch — the reason it is still on this list. */
  state: string;
  /** Checkpoint mtime → most recently touched first. */
  when: number;
  /** The language that work was being done in — so the question about it is asked in the same one. */
  language?: string;
}

/** Long enough to recognise the work, short enough to sit on one line of a choice list. */
export const MAX_WHAT_CHARS = 110;

function oneLine(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= MAX_WHAT_CHARS ? t : `${t.slice(0, MAX_WHAT_CHARS - 1).trimEnd()}…`;
}

/**
 * What is being done in a session, in the words of whoever asked for it.
 *
 * The checkpoint holds three descriptions and they are not equally useful. `refinedPrompt` is a sentence
 * about the work ("Process the evidence into the e2e test report for the product creation wizard, then
 * proceed to the next testing step"); `title` is a slug for a branch name; `rawPrompt` is what the user typed,
 * which for a continuation is often just "devam". So: the sentence, then the title, then the last thing that
 * was committed — and only then an admission that nothing here says.
 */
async function whatIsHappening(
  git: GitRunner, repoRoot: string, root: string, baseBranch: string,
): Promise<string> {
  const cp = readCheckpoint(root);
  if (cp?.refinedPrompt?.trim()) return oneLine(cp.refinedPrompt);
  if (cp?.title?.trim()) return oneLine(cp.title.replace(/-/g, " "));
  const last = await git(["log", "-1", "--format=%s", baseBranch], repoRoot);
  if (last.code === 0 && last.stdout.trim()) return oneLine(last.stdout);
  return "no description was recorded for this work";
}

/**
 * Every session that still holds something the main branch does not.
 *
 * `merged` is not offered: its commits are in the trunk and continuing there would be building on a branch
 * whose whole point has already been served. `orphan` is not offered either — git no longer tracks it, so
 * nothing can be said about what is in it, which is exactly the case where a choice would be a guess.
 */
export async function ongoingWork(
  git: GitRunner, repoRoot: string, mainBranch: string,
): Promise<Ongoing[]> {
  const survey = await surveySessions(git, repoRoot, mainBranch).catch(() => []);
  const out: Ongoing[] = [];
  for (const s of survey) {
    if (s.verdict !== "unmerged" && s.verdict !== "dirty") continue;
    const cp = readCheckpoint(s.root);
    out.push({
      slug: s.slug,
      root: s.root,
      baseWorktree: join(s.root, "base"),
      baseBranch: s.baseBranch,
      what: await whatIsHappening(git, repoRoot, s.root, s.baseBranch),
      state: s.detail,
      when: checkpointMtime(s.root),
      ...(cp?.language ? { language: cp.language } : {}),
    });
  }
  return out.sort((a, b) => b.when - a.when);
}

/** The choice that means "leave all of that alone". Matched by position, so its wording is free to change. */
export const NEW_WORK_LABEL = "Start fresh — a new worktree";

export const ONGOING_QUESTION =
  "There is work already open in this project that has not reached the main branch. Carry on with one of "
  + "these, or start something new?";

/** The list as `ask_user` choices: the session's name, and one sentence about what is being done in it. */
export function ongoingChoices(items: Ongoing[]): Choice[] {
  return [
    ...items.map((o) => ({ label: o.slug, description: `${o.what} — ${o.state}` })),
    { label: NEW_WORK_LABEL, description: "Nothing above is this; open a new worktree for it." },
  ];
}

/**
 * Asks which of them to work in — and returns nothing when the answer is "a new one".
 *
 * Matched by POSITION rather than by label: the labels are shown in the user's own language (see
 * askInUserLanguage), and a translated slug that no longer equals `o.slug` would otherwise select nothing.
 */
export async function chooseOngoing(
  deps: ReviewDeps,
  askUser: AskUser,
  language: string | undefined,
  items: Ongoing[],
): Promise<Ongoing | undefined> {
  if (!items.length) return undefined;
  const choices = ongoingChoices(items);
  const answer = (await askInUserLanguage(deps, askUser, language, ONGOING_QUESTION, choices)).trim();
  const at = choices.findIndex((c) => c.label === answer);
  return at >= 0 && at < items.length ? items[at] : undefined;
}
