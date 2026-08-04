import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import { ToolRegistry } from "../tools/registry.js";
import { defaultGitRunner, type GitRunner } from "../worktree/git.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import type { RoleRegistry } from "../agent/roles.js";
import type { Provider } from "../core/types.js";
import type { PermissionEngine } from "../permission/engine.js";
import type { Card } from "../board/board.js";

/** How many of the project's own recent subjects are shown as the convention. Enough to see the shape. */
export const MAX_EXAMPLES = 12;

/** Azure prefixes every merge subject with this; the convention is what follows it. */
const MERGED_PREFIX = /^Merged PR \d+:\s*/;

/** Enough to read the task list it was handed and write two fields. It has no tools and nothing to explore. */
export const PR_SUMMARY_MAX_TURNS = 3;

export const PRSummarySchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});
export type PRSummary = z.infer<typeof PRSummarySchema>;

/**
 * The subjects this project merged recently, as the convention to follow.
 *
 * Learned rather than assumed, because a house style is not guessable: parrot writes
 * `feat(orders): A101/BIM siparişlerinde bayi no & şube no arayüzden düzenlenebilir` — conventional prefix,
 * Turkish subject. A hard-coded template would be wrong in half the repositories it ran in, and telling the
 * model "use conventional commits" would still lose the language and the scope vocabulary.
 */
export async function recentSubjects(git: GitRunner, cwd: string, base: string): Promise<string[]> {
  const read = async (args: string[]): Promise<string[]> => {
    const r = await git(args, cwd);
    if (r.code !== 0) return [];
    return r.stdout.split("\n").map((s) => s.replace(MERGED_PREFIX, "").trim()).filter(Boolean);
  };
  // Merges first: on a pull-request workflow those ARE the pull request titles.
  const merges = await read(["log", "--merges", "--format=%s", "-n", "40", base]);
  const subjects = merges.length >= 3 ? merges : await read(["log", "--format=%s", "-n", "40", base]);
  return subjects.slice(0, MAX_EXAMPLES);
}

/**
 * What the pull request is asked to say.
 *
 * Measured on PR #765, which is what this replaces: the title was `hc: product-description-rendering-bug`
 * — the internal job slug — and the description was `Completed tasks:` followed by 27 internal task cards
 * ("Extend SafeHtmlFallbackRecord interface with failureKind union in safe-html.pipe.ts"). Nobody reviewing
 * it could tell what changed for a user or why, and the title matched nothing else in the repository.
 */
export function prAskMessage(request: string, tasks: string[], examples: string[]): string {
  const convention = examples.length
    ? `Recent titles from THIS repository — follow their format, their language and their scope vocabulary:\n`
      + examples.map((e) => `- ${e}`).join("\n")
    : `No examples were found in this repository. Use Conventional Commits: \`type(scope): subject\`.`;
  return [
    `Write the title and description for the pull request that delivers this work.`,
    ``,
    `What was asked for:\n${request}`,
    ``,
    convention,
    ``,
    `The title is ONE conventional-commit line: \`type(scope): subject\`, in the same language as the examples,`,
    `describing the OUTCOME — not the job, not a branch name, not a slug.`,
    ``,
    `The description is short prose for a human reviewer, in the same language: what this changes, and why it`,
    `was needed. Two or three sentences, or a handful of bullets. It is NOT a task list and NOT a file list —`,
    `the tasks are appended separately. Do not describe internal roles, cards, or the process that produced it.`,
    ``,
    `The tasks that were completed, for your information only:\n${tasks.map((t) => `- ${t}`).join("\n")}`,
    ``,
    `Return {title, body} via submit.`,
  ].join("\n");
}

/** The internal record, kept but demoted: useful when reviewing, wrong as the description. */
export function withTaskList(body: string, tasks: string[]): string {
  if (!tasks.length) return body;
  return `${body.trim()}\n\n<details>\n<summary>Completed tasks (${tasks.length})</summary>\n\n`
    + tasks.map((t) => `- ${t}`).join("\n") + `\n</details>\n`;
}

/** What a run opens when the summary cannot be written — the previous behaviour, unchanged. */
export function fallbackPR(jobSlug: string, tasks: string[]): PRSummary {
  return { title: `hc: ${jobSlug}`, body: "Completed tasks:\n" + tasks.map((t) => `- ${t}`).join("\n") };
}

export interface PRSummaryDeps {
  provider: Provider;
  roleRegistry: RoleRegistry;
  permission: PermissionEngine;
  approve: RoleAgentOptions["approve"];
  signal: AbortSignal;
  git?: GitRunner;
}

/**
 * Never the reason a pull request fails to open.
 *
 * The work is merged and pushed by the time this runs; a model that will not answer is a worse title, not a
 * lost delivery. The caller gets the previous slug-and-task-list on any failure.
 */
export async function prSummary(
  deps: PRSummaryDeps,
  opts: { request: string; cards: Card[]; cwd: string; base: string; jobSlug: string },
): Promise<PRSummary> {
  const tasks = opts.cards.map((c) => c.title);
  try {
    const git = deps.git ?? defaultGitRunner;
    const examples = await recentSubjects(git, opts.cwd, opts.base);
    const resolved = deps.roleRegistry.resolve("operational");
    const summary = await runStructuredRole(
      {
        provider: deps.provider, ...resolved, tools: new ToolRegistry(),
        messages: [{ role: "user", content: prAskMessage(opts.request, tasks, examples) }],
        permission: deps.permission, approve: deps.approve, cwd: opts.cwd, signal: deps.signal,
        maxTurns: PR_SUMMARY_MAX_TURNS,
      },
      PRSummarySchema,
    );
    return { title: summary.title.trim(), body: withTaskList(summary.body, tasks) };
  } catch {
    return fallbackPR(opts.jobSlug, tasks);
  }
}
