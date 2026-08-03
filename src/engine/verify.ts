import { existsSync } from "node:fs";
import { relative } from "node:path";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runToCompletion } from "../agent/loop.js";
import { ToolRegistry } from "../tools/registry.js";
import { readFileTool } from "../tools/read.js";
import { writeFileTool } from "../tools/write.js";
import { editFileTool } from "../tools/edit.js";
import { grepTool } from "../tools/grep.js";
import { globTool } from "../tools/glob.js";
import { shellTool } from "../tools/shell.js";
import { createWebFetchTool } from "../tools/web.js";
import { gitTool } from "../tools/git.js";
import { buildSkillTool } from "../skills/apply.js";
import { buildAskUserTool } from "./writer-registry.js";
import type { AskUser } from "./review.js";
import { contextTools, projectToolsNote, BATCH_TOOLS_NOTE } from "./task-types.js";
import type { TaskCycleDeps } from "./task-types.js";
import { verifyPaths, featureSlugFor, specsDir } from "../speckit/layout.js";
import { loadGraphSync } from "./project-graph.js";

/**
 * Verifying work that already exists.
 *
 * The lane exists because the alternative was wrong in both directions. Classified as a feature, "run this
 * pull request's scenarios" bought the whole pipeline — a worktree cut from a branch, a spec, a plan, a task
 * board, waves of implementers, a review council — to produce a document, and it would have ended by opening
 * a second pull request for work that was already in one. Classified as chat, it reached the coach, which has
 * no shell and cannot write: it could discuss the scenarios but not run a query, read a log, or record a
 * result.
 *
 * So it runs like `govern` does: in the project the user is standing in, on the branch they are on. That is
 * not a shortcut, it follows from what the work IS. The developer starts the environment, confirms it is up,
 * and looks at the screen when a scenario needs an eye on it — they are present for the whole run, and a
 * report growing in their own working tree is one they can watch.
 *
 * Scenarios run ONE AT A TIME, and that is deliberate rather than unambitious. A test report is a living
 * document: each result is written down with its evidence before the next scenario starts, so a run that is
 * interrupted leaves behind everything it learned. Waves of parallel testers would produce a report assembled
 * at the end, which is exactly the report that is empty when it matters.
 */

/** Long, because a scenario can need a dozen observations and there is no second attempt after a timeout. */
export const VERIFY_MAX_TURNS = 300;

export interface VerifyResult {
  /** Repo-relative directory holding everything this run produced. */
  dir: string;
  planPath: string;
  reportPath: string;
  planWritten: boolean;
  reportWritten: boolean;
}

/**
 * What the tester may do.
 *
 * `shell` is the reason this cannot be a chat turn: the evidence the report needs lives behind `psql` and a
 * `curl` at a log API, and a role that cannot run them can only speculate. Writing is not limited to the
 * report either — a project whose rules say an untriggerable scenario must be opened up by changing the mock
 * server needs a role that can change the mock server.
 */
function testerTools(deps: TaskCycleDeps, askUser: AskUser): ToolRegistry {
  const r = new ToolRegistry();
  r.register(readFileTool);
  r.register(writeFileTool);
  r.register(editFileTool);
  r.register(grepTool);
  r.register(globTool);
  r.register(shellTool);
  r.register(gitTool);
  r.register(createWebFetchTool());
  r.register(buildSkillTool(deps.skillRegistry));
  // The developer is present for this whole run — asking them is the point, not a fallback.
  r.register(buildAskUserTool(askUser));
  for (const t of contextTools(deps)) r.register(t);
  // Whatever the project has connected: a work-item tracker holding the scenarios, a log or metrics server.
  for (const t of deps.mcpTools?.() ?? []) r.register(t);
  return r;
}

async function runTester(
  deps: TaskCycleDeps, workdir: string, tools: ToolRegistry, message: string,
): Promise<void> {
  const { model, fallbacks, onExhausted, onFallback } = deps.roleRegistry.fallbackOpts("tester");
  const opts: RoleAgentOptions = {
    provider: deps.provider,
    model,
    fallbacks,
    onExhausted,
    onFallback,
    systemPrompt: deps.roleRegistry.resolve("tester").systemPrompt
      + deps.roleRegistry.ruleSuffix()
      + projectToolsNote(tools.list(), !!loadGraphSync(workdir))
      + BATCH_TOOLS_NOTE,
    tools,
    maxTurns: VERIFY_MAX_TURNS,
    messages: [{ role: "user", content: message }],
    permission: deps.permission,
    approve: deps.approve,
    cwd: workdir,
    signal: deps.signal,
    // A verification is the longest interactive stretch there is: the tool cards ARE the record of what was
    // observed, and everything the tester says is addressed to the developer sitting in front of it.
    onActivity: deps.onActivity,
    onLiveActivity: deps.onLiveActivity,
    /** …and a correction — "skip that one, the data is gone" — must reach it mid-run, not after the report. */
    inbox: deps.inbox,
    ...(deps.note ? { onSay: deps.note } : {}),
  };
  /**
   * `runToCompletion`, not `runRoleAgent`.
   *
   * `runRoleAgent` is an async GENERATOR: awaiting it hands back the generator object and never iterates it,
   * so the agent does not run and the call returns instantly having done nothing. Measured: one call in the
   * whole turn — the refiner's — and then "no test plan was written", with the tester never having spoken.
   */
  await runToCompletion(opts);
}

/** The scenario table a report is filled in against — written by horse-code, not asked for. */
function planMessage(prompt: string, planRel: string, dirRel: string): string {
  return `${prompt}\n\n`
    + `There is no test plan for this work yet, so write one FIRST, to "${planRel}".\n\n`
    + `Find out what is being verified before you write a scenario: read the pull request or work item if one `
    + `is named (use the tools you have for it), read the spec and plan in "${dirRel}" if they are there, and `
    + `read the code that changed. A scenario invented from a title tests nothing.\n\n`
    + `The plan is a table of scenarios. Each row: an id, what the scenario does, what is expected, and WHERE `
    + `the evidence for it will come from — which table and column, which log event, which screen. A row `
    + `whose evidence source you cannot name is a row you cannot verify, so name it or drop the row.\n\n`
    + `Also list, before the table: what the developer must have running, and the exact commands for it. You `
    + `do not run them.\n\n`
    + `Write the plan and stop. Do not run any scenario yet.`;
}

/** The run itself: execute, observe, record — in that order, one scenario at a time. */
function runMessage(prompt: string, planRel: string, reportRel: string): string {
  return `${prompt}\n\n`
    + `The test plan is "${planRel}". Work through its scenarios IN ORDER, and record each result in `
    + `"${reportRel}" — with its evidence — before you start the next one.\n\n`
    + `Create the report if it is not there. If it IS there, this is a resumed session: read it first and `
    + `continue from the first scenario that has no result. Do not re-run what is already recorded, and do `
    + `not rewrite results someone else established.\n\n`
    + `Before the first scenario, check what the plan says must be running. If it is not up, tell the `
    + `developer which command to run and ask them to confirm — then wait. Never start it yourself.\n\n`
    + `When a scenario needs an eye on the screen, describe exactly what to look at and ask the developer what `
    + `they see. Their answer is the evidence; record it as theirs.`;
}

/**
 * Runs the verification, in place.
 *
 * Two phases, because they fail differently. Writing the plan is research — what does this work do, and how
 * would anyone tell? Running it is observation, and it needs the environment up and the developer present. A
 * run that already has a plan skips straight to the second, which is what makes a stopped session resumable.
 */
export async function runVerify(opts: {
  deps: TaskCycleDeps;
  workdir: string;
  prompt: string;
  title: string;
  askUser: AskUser;
  note?: (text: string) => void;
}): Promise<VerifyResult> {
  const { deps, workdir, prompt, title, askUser } = opts;
  const slug = featureSlugFor(workdir, title);
  const paths = verifyPaths(workdir, slug);
  /**
   * The directory is NOT created here.
   *
   * It used to be, and a run that wrote nothing left an empty folder behind — which then claimed its number,
   * so the next attempt was numbered past it. Measured after two failed runs: `002-product-wizard-testing`
   * and `003-product-creation-wizard-smoke-tests`, both empty, for work that had produced not one line.
   *
   * `write_file` creates the parents of whatever it writes, so the directory appears exactly when there is
   * something to put in it.
   */

  const dirRel = relative(workdir, paths.dir);
  const planRel = relative(workdir, paths.plan);
  const reportRel = relative(workdir, paths.report);
  const tools = testerTools(deps, askUser);

  const hadPlan = existsSync(paths.plan);
  opts.note?.(hadPlan
    ? `🧪 Verifying against \`${planRel}\`.`
    : `🧪 No test plan for this work yet — writing \`${planRel}\` first.`);
  if (!hadPlan) await runTester(deps, workdir, tools, planMessage(prompt, planRel, dirRel));

  // A plan the phase never wrote means there is nothing to run against, and running anyway would produce a
  // report of scenarios the tester made up on the spot.
  if (!existsSync(paths.plan)) {
    return { dir: dirRel, planPath: planRel, reportPath: reportRel, planWritten: false, reportWritten: false };
  }
  await runTester(deps, workdir, tools, runMessage(prompt, planRel, reportRel));
  return {
    dir: dirRel, planPath: planRel, reportPath: reportRel,
    planWritten: true, reportWritten: existsSync(paths.report),
  };
}

/** What the user is told when it ends. */
export function describeVerify(r: VerifyResult, branch: string): string {
  if (!r.planWritten) {
    return `⚠️ No test plan was written to \`${r.planPath}\` — nothing was verified.`;
  }
  const head = r.reportWritten
    ? `🧪 Test report: \`${r.reportPath}\``
    : `⚠️ The plan is at \`${r.planPath}\`, but no report was written — nothing was recorded.`;
  return `${head}\n\nEverything this run produced is in \`${r.dir}\`, on branch \`${branch}\` — `
    + `uncommitted, in your working tree.`;
}

/**
 * The branch the report will land on.
 *
 * Named in the closing line rather than assumed, because this lane writes into the user's own checkout: a
 * report for a pull request written while standing on `development` is on the wrong branch, and the only
 * moment that is cheap to notice is before they close the terminal.
 */
export async function currentBranchOf(cwd: string): Promise<string> {
  const { defaultGitRunner } = await import("../worktree/git.js");
  const r = await defaultGitRunner(["symbolic-ref", "--short", "HEAD"], cwd);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : "(detached)";
}

/** Where the run's documents will go, for a caller that needs to say so before starting. */
export function verifyDir(workdir: string, title: string): string {
  return relative(workdir, verifyPaths(workdir, featureSlugFor(workdir, title)).dir) || specsDir(workdir);
}
