import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { existsSync } from "node:fs";
import type { TaskCycleDeps } from "./task-types.js";
import { readOnlyRegistry } from "./reviewer.js";
import { runToCompletion } from "../agent/loop.js";
import { defaultGitRunner } from "../worktree/git.js";
import { createWebFetchTool } from "../tools/web.js";

/**
 * The research lane: a question answered in a document, with nothing else changed.
 *
 * Some requests want a decision made, not a change made — "which queue should we use", "compare these three
 * approaches", "is this migration worth it". Sent down the pipeline they buy a brainstorm, a spec, a plan, a
 * board and a review council, and the thing actually wanted — a comparison, with the trade-offs and a
 * recommendation — arrives as a side effect if at all.
 *
 * So this is a lane beside `verify` and `govern`: it opens a worktree like they do, writes one document, and
 * commits it. What it never does is touch the source, and that is a STRUCTURAL guarantee rather than an
 * instruction. The agent is handed a read-only tool set — read, grep, glob, git history, the code graph, the
 * project's skills — and no writer at all. It cannot edit a file because there is nothing to edit with; the
 * report is its ANSWER, and horse-code is what puts it on disk. A prompt saying "do not write code" is a
 * request an agent can misread under pressure. A registry without a write tool is not.
 *
 * What it can reach beyond the repository is one thing, and worth stating plainly: `web_fetch` retrieves a
 * URL. There is no web SEARCH here, so a question whose answer lives on pages nobody has named is answered
 * from the model's own knowledge and the code in front of it. Connect a search MCP and it has more.
 */

export interface ResearchResult {
  /** Repo-relative path of the document, whether or not it was written. */
  reportPath: string;
  written: boolean;
  /** Whether the document was committed — false when the workdir is not somewhere horse-code may commit. */
  committed: boolean;
}

/**
 * How long a research agent may work.
 *
 * Lower than verification's 300, which spends most of its turns waiting on a person carrying out scenarios.
 * Research is reading: a turn is a file or a page, and a question that has not been answered in this many is
 * a question that needed to be narrowed.
 */
export const RESEARCH_MAX_TURNS = 120;

/**
 * Where this project already keeps written investigations.
 *
 * The same reasoning `testDocDirs` applies to test documents: a project that has researched before has the
 * documents to show for it, and they are not where horse-code would put them. Writing a second directory
 * beside an established one splits the record in two, and the half nobody remembers is the one that rots.
 */
export function researchDir(trackedFiles: readonly string[]): string {
  const known = [/^docs\/research\//i, /^docs\/adr\//i, /^docs\/decisions\//i, /^research\//i, /^\.planning\//i];
  for (const re of known) {
    const hit = trackedFiles.find((f) => re.test(f.replace(/\\/g, "/")));
    if (hit) return dirname(hit.replace(/\\/g, "/"));
  }
  return "docs/research";
}

/** A filename from the request's own title — the subject, which is what someone scanning the directory reads. */
export function reportName(title: string, now = new Date()): string {
  const slug = (title || "research").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  const day = now.toISOString().slice(0, 10);
  return `${day}-${slug || "research"}.md`;
}

/**
 * What the report must contain, and the one thing it must not do.
 *
 * Comparisons are the point: a recommendation with no alternatives beside it is an assertion, and the reader
 * cannot tell a considered choice from the first idea that occurred to anyone. The trade-offs are what make
 * it arguable, and a research document that cannot be argued with has not done its job.
 */
export const researchRule =
  "You are researching a question and writing ONE document. You are not changing this project: you have no "
  + "tool that writes a file, and the report is your final answer — horse-code writes it down.\n\n"
  + "Ground the answer in THIS repository before anything else. Read the code that the question is about; a "
  + "recommendation that ignores what is already here is a recommendation for a different project.\n\n"
  + "The document must contain, in this order:\n"
  + "1. The question, restated in one or two sentences as you understood it.\n"
  + "2. What this project does today in the area concerned, with file paths — the starting position.\n"
  + "3. The options, one section each. For every option: how it would work here, what it costs, and what it "
  + "rules out. An option nobody would pick is still worth a paragraph saying why not.\n"
  + "4. A comparison table across the dimensions that actually decide this one. Choose the dimensions from "
  + "the question rather than from habit.\n"
  + "5. A recommendation, with the condition that would change it. A recommendation that nothing could "
  + "overturn is a preference wearing a suit.\n"
  + "6. What you could not establish, and what it would take to settle. Say it plainly — an unexamined "
  + "assumption presented as a finding is the one failure this document cannot recover from.\n\n"
  + "Write markdown. Cite file paths for claims about this project and URLs for claims about the world. Where "
  + "you are reasoning from your own knowledge rather than from something you read, say so.";

/**
 * Runs the lane. Returns where the document landed, or that nothing was written.
 *
 * Nothing here asks the user anything: a research request is answered, not negotiated. The pipeline's
 * brainstorm exists because building the wrong thing is expensive; writing the wrong report costs one
 * document, and reading it is how someone discovers the question was wrong.
 */
export async function runResearch(opts: {
  deps: TaskCycleDeps;
  workdir: string;
  prompt: string;
  title: string;
  /** The session's language: the report is for a person, so it is written in theirs. */
  language?: string;
  trackedFiles?: readonly string[];
  note?: (text: string) => void;
}): Promise<ResearchResult> {
  const { deps, workdir } = opts;
  // Asked here when the caller did not bring a list: where a project keeps its investigations is a property
  // of the repository, and a lane should not have to know how to ask git to find that out.
  const dir = researchDir(opts.trackedFiles ?? await trackedFiles(workdir));
  const rel = join(dir, reportName(opts.title));

  const tools = readOnlyRegistry(deps, { remember: true });
  // The one reach outside the repository. Read-only by its own construction — it retrieves a URL's text.
  tools.register(createWebFetchTool());

  const language = opts.language
    ? `\n\nWrite the document in ${opts.language}. Keep file paths, identifiers and URLs exactly as they are.`
    : "";
  /**
   * The user's standing rules, asked for by name.
   *
   * This prompt is written here rather than resolved from a role, and `resolve()` is what normally appends
   * them — so without this line the one agent a research request ever runs would be the one agent in the
   * system that had never heard of the user's rules. Caught by the test that walks every prompt
   * construction, which exists because that failure compiles cleanly and is silent.
   */
  const rules = deps.roleRegistry.ruleSuffix();
  /**
   * The analyst's chain, and its whole chain.
   *
   * `analyst` is the role that authors the spec and the constitution — the reasoning work of the project —
   * and a comparison somebody will decide on is the same shape. `fallbackOpts` carries the fallbacks with
   * it, so one subscription's rate limit does not end a research run any more than it ends a trace run.
   */
  const last = await runToCompletion({
    ...deps.roleRegistry.fallbackOpts("analyst"),
    systemPrompt: researchRule + language + rules,
    messages: [{ role: "user", content: opts.prompt }],
    tools,
    maxTurns: RESEARCH_MAX_TURNS,
    provider: deps.provider,
    permission: deps.permission,
    approve: deps.approve,
    cwd: workdir,
    signal: deps.signal,
    onActivity: deps.onActivity,
    onLiveActivity: deps.onLiveActivity,
    inbox: deps.inbox,
    ...(opts.note ? { onSay: opts.note } : {}),
  });

  const body = (last.content ?? "").trim();
  if (!body) return { reportPath: rel, written: false, committed: false };

  const abs = join(workdir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `${body}\n`, "utf8");
  return { reportPath: rel, written: true, committed: await commitReport(workdir, rel, opts.title) };
}

/** What git tracks here — for deciding where the project already keeps its written investigations. */
async function trackedFiles(cwd: string): Promise<string[]> {
  try {
    const r = await defaultGitRunner(["ls-files"], cwd);
    return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
  } catch { return []; }
}

/**
 * Commits the document on the branch it was written on.
 *
 * A report left uncommitted in a worktree is indistinguishable from a run that failed — the same reasoning
 * the trace run needed. It commits only the report: a research run changes nothing else, so a commit that
 * swept up anything more would be describing work it did not do.
 */
export async function commitReport(workdir: string, rel: string, title: string): Promise<boolean> {
  if (!existsSync(join(workdir, ".git")) && !existsSync(join(workdir, rel))) return false;
  const add = await defaultGitRunner(["add", "--", rel], workdir);
  if (add.code !== 0) return false;
  const staged = await defaultGitRunner(["diff", "--cached", "--quiet", "--", rel], workdir);
  if (staged.code === 0) return false; // identical to what is already committed
  const r = await defaultGitRunner(["commit", "-m", `docs(research): ${title || "findings"}`, "--", rel], workdir);
  return r.code === 0;
}

/** What the person is told when the lane finishes. */
export function describeResearch(r: ResearchResult, branch: string): string {
  if (!r.written) return "The research produced no document — nothing was written.";
  const where = r.committed
    ? `Committed on \`${branch}\`.`
    : "Written, but not committed — it is in the working tree.";
  return `📄 **Research report:** \`${r.reportPath}\`\n${where}\n\n`
    + "_No code was changed: the lane runs without a write tool at all._";
}

/** The path a report would take, for a caller that wants to say so before the work starts. */
export function plannedPath(title: string, trackedFiles: readonly string[]): string {
  return relative(".", join(researchDir(trackedFiles), reportName(title))).replace(/\\/g, "/");
}
