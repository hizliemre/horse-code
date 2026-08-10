import { sessionBase } from "./session-scope.js";
import { respondIn } from "./language.js";
import { constitutionNote } from "./constitution-store.js";
import { existsSync, readFileSync } from "node:fs";
import { relative, join, resolve } from "node:path";
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
import { deferMcp } from "./reviewer.js";
import { memoryHints, reinforceUsed } from "./memory-inject.js";
import { buildSkillTool } from "../skills/apply.js";
import { buildAskUserTool } from "./writer-registry.js";
import type { AskUser } from "./review.js";
import { contextTools, projectToolsNote, BATCH_TOOLS_NOTE } from "./task-types.js";
import type { TaskCycleDeps } from "./task-types.js";
import { verifyPaths, featureSlugFor, specsDir } from "../speckit/layout.js";
import { loadGraphSync } from "./project-graph.js";
import { attachedImages } from "../agent/attach.js";
import { FindingQueue, buildReportFindingTool, type Finding } from "./finding.js";
import { triageFinding, describeEscalation } from "./triage.js";
import { runFix, commitFix, describeFix, dirtyPaths } from "./fix.js";
import { refreshAfterChange } from "./trace-refresh.js";
import { defaultGitRunner } from "../worktree/git.js";
import type { ReviewDeps } from "./review.js";

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
function testerTools(deps: TaskCycleDeps, askUser: AskUser, findings: FindingQueue): ToolRegistry {
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
  // The one thing the tester does about a defect: say so. Fixing is another role's job, deliberately.
  r.register(buildReportFindingTool(findings));
  for (const t of contextTools(deps)) r.register(t);
  // Whatever the project has connected: a work-item tracker holding the scenarios, a log or metrics server.
  // Named in the system prompt, fetched on demand — the tester carried 49 schemas through every one of its
  // turns and called none of them. See src/tools/find-tool.ts.
  deferMcp(r, deps.mcpTools?.() ?? []);
  return r;
}

/**
 * What earlier runs learned, handed to the role that is about to hit the same ground.
 *
 * The tester was the last role running blind. Measured on one run: 721 memories in the store, 551 model
 * calls, and not one memory reaching any of them — a gap that was invisible until injection was recorded in
 * telemetry, and which the tester is the clearest case for. "The environment needs X running", "that
 * scenario needs the mock profile" is what a previous session paid a developer's attention to find out, and
 * re-learning it costs another round trip through them.
 *
 * The fixer already had this: it runs through `runTaskCycle` → the implementer, which injects and credits by
 * the files it touched. Only this path was missing.
 */
async function runTester(
  deps: TaskCycleDeps, workdir: string, tools: ToolRegistry, message: string, language?: string,
  law = "",
  /** The user's actual request — what memory is retrieved on. See the note below for why not `message`. */
  subject?: string,
): Promise<void> {
  /**
   * Retrieved on the SUBJECT, not on the message that carries it.
   *
   * The message is mostly instructions, and memory scoring is lexical, so the instructions are what it
   * matches on. Measured against the real 746-memory store: the same 2,273-character tester message returned
   * the same five memories — `npm install`, `npm audit`, `git branch --merged` — whichever request was
   * embedded in it, while the bare request retrieved the one that actually applied ("product creation is a
   * draft-first six-step wizard"). The boilerplate is identical on every call; only the request differs, and
   * it was the part being outvoted.
   */
  const hints = memoryHints(deps, subject ?? message, { role: "tester" });
  const { role: agentRole, model, fallbacks, onExhausted, onFallback } = deps.roleRegistry.fallbackOpts("tester");
  const opts: RoleAgentOptions = {
    provider: deps.provider,
    role: agentRole,
    model,
    fallbacks,
    onExhausted,
    onFallback,
    // `resolve` already appends the user's rules — adding them again put all 25 in twice.
    systemPrompt: deps.roleRegistry.resolve("tester").systemPrompt
      + projectToolsNote(tools.list(), !!loadGraphSync(workdir))
      + BATCH_TOOLS_NOTE
      + law
      // The tester asks the developer questions and writes the report they read. See src/engine/language.ts.
      + respondIn(language),
    tools,
    maxTurns: VERIFY_MAX_TURNS,
    // A screenshot named in the request comes with it — the same way a mid-run note carries one.
    messages: [
      // What earlier runs learned about this area, ahead of the request — see runTester's own note.
      ...(hints?.message ? [{ role: "user" as const, content: hints.message }] : []),
      { role: "user", content: message, ...(() => {
        const images = attachedImages(message, workdir);
        return images.length ? { images } : {};
      })() },
    ],
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
  const last = await runToCompletion(opts);
  // …and credit whatever it actually used, or the store only ever learns that memories were SENT.
  reinforceUsed(deps, hints.ids, last.content ?? "", "tester");
}

/**
 * Where this project already keeps test documents.
 *
 * A project that has been tested before has the documents to show for it, and they are not where horse-code
 * would put them. Measured on a real one: 237 of them under `docs/superpowers/test-plans/`, including an
 * 813-line report for the very pull request being verified — thirteen scenarios already PASSED, the rest
 * pending. Announcing "there is no test plan" and writing a second one would have discarded that record.
 *
 * DIRECTORIES, not documents. Two hundred filenames in a prompt is not a hint, it is the search — and
 * searching is what the tester has grep for.
 */
export function testDocDirs(trackedFiles: string[]): string[] {
  const count = new Map<string, number>();
  for (const f of trackedFiles) {
    const p = f.replace(/\\/g, "/");
    if (!/\.mdx?$/i.test(p)) continue;            // source with "test" in its path is not a test document
    if (!/(^|\/)(test-plans?|test-reports?)\//i.test(p) && !/(test-plan|test-report|-e2e)\.mdx?$/i.test(p)) continue;
    const dir = p.slice(0, p.lastIndexOf("/"));
    if (dir) count.set(dir, (count.get(dir) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4).map(([d]) => d);
}

/**
 * How a run says which document it is actually keeping the results in.
 *
 * An existing report is continued WHERE IT LIVES — that is where its history is and where the team looks —
 * while the rule that a run's output sits in one folder still has to hold. The pointer is how both survive:
 * the folder gets a file naming the real one, in a marker that renders as nothing and reads back exactly.
 */
export const POINTER_MARK = /<!--\s*report:\s*(.+?)\s*-->/;
export const POINTER_HINT = '<!-- report: PATH -->';

/** The document a pointer file points at, or undefined when the file IS the results. */
export function readPointer(pointerPath: string): string | undefined {
  try {
    const m = POINTER_MARK.exec(readFileSync(pointerPath, "utf8"));
    return m?.[1]?.trim() || undefined;
  } catch { return undefined; }
}

/** Files git tracks in this working directory. */
async function trackedFiles(cwd: string): Promise<string[]> {
  try {
    const { defaultGitRunner } = await import("../worktree/git.js");
    const r = await defaultGitRunner(["ls-files"], cwd);
    return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
  } catch { return []; }
}

/** The scenario table a report is filled in against — written by horse-code, not asked for. */
export function planMessageFor(
  prompt: string, planRel: string, pointerRel: string, dirRel: string, docDirs: string[],
): string {
  const where = docDirs.length
    ? `This project already keeps test documents in ${docDirs.map((d) => `\`${d}\``).join(", ")}. `
      + `Search there FIRST — by the feature's name, by the pull request number, by the branch.`
    : `Search the repository for one anyway: a project can keep them anywhere.`;
  return `${prompt}\n\n`
    + `FIRST, find out whether a test document for this work already exists. ${where} Also check "${dirRel}".\n\n`
    + `A document that already exists is CONTINUED, never replaced. It holds results someone established and `
    + `evidence they gathered, and writing a second one beside it throws that away while leaving two documents `
    + `that disagree. If you find one — even a partly finished one, even one that calls itself a plan — say so `
    + `and record it by writing "${pointerRel}" containing one line:\n\n`
    + `    ${POINTER_HINT.replace("PATH", "the path you found")}\n\n`
    + `…plus a sentence for a human saying which document this run continues. Then STOP.\n\n`
    + `IF THERE IS NONE, look at what you were asked. When the request already names what to check and what `
    + `the right answer looks like — "confirm from the screenshot that X renders as Y" — that IS the plan: `
    + `write nothing, and say so in one line. A plan document is for "run the tests for this pull request", `
    + `where what to check has to be worked out first.\n\n`
    + `ONLY IF NEITHER: write a new plan to "${planRel}" — that exact path, and nowhere else. `
    + `The directories above are where you LOOK for something that already exists; they are not where a new `
    + `document goes. Everything a run produces belongs in its own folder, so that one piece of work has one `
    + `account of itself instead of pieces in two places.\n\n`
    + `Find out what is being verified before you write a scenario: read the pull request or work item if one `
    + `is named (use the tools you have for it), read the spec and plan in "${dirRel}" if they are there, and `
    + `read the code that changed. A scenario invented from a title tests nothing.\n\n`
    + `The plan is a table of scenarios. Each row: an id, what the scenario does, what is expected, and WHERE `
    + `the evidence for it will come from — which table and column, which log event, which screen. A row `
    + `whose evidence source you cannot name is a row you cannot verify, so name it or drop the row.\n\n`
    + `Also list, before the table: what the developer must have running, and the exact commands for it. You `
    + `do not run them.\n\n`
    + `Write at most one file, then stop. Do not run any scenario yet.`;
}

/**
 * What the tester is told when the request itself is the thing to verify.
 *
 * No plan, because there is nothing a plan would add: the request already names the check and what the right
 * answer looks like. The report is still written, because a result without a record is a result nobody has.
 */
function directMessage(prompt: string, reportRel: string): string {
  return `${prompt}\n\n`
    + `There is no test plan for this, and none is needed — what you have been asked to check is stated above. `
    + `Verify exactly that, and nothing more.\n\n`
    + `Record the result in "${reportRel}" with its evidence: what you did, what you observed, and where the `
    + `evidence came from. Create the file if it is not there; if it is, append rather than replacing what is `
    + `already recorded.\n\n`
    + `If you cannot run the check — the environment is not up, the data does not exist — say which command `
    + `the developer should run and ask them, then wait. Never start it yourself.\n\n`
    + `When it needs an eye on the screen, describe exactly what to look at and ask what they see. Their `
    + `answer is the evidence; record it as theirs.\n\n`
    + `${handOffRule}\n\n`
    + `If what you find is wrong but is NOT what you were asked to check, use \`report_finding\` — do not fix `
    + `anything yourself.`;
}

/** …and when a fix has landed and it should look again. */
function directResumeMessage(prompt: string, reportRel: string, done: string[]): string {
  return `The findings you reported have been dealt with:\n${done.map((d) => `- ${d}`).join("\n")}\n\n`
    + `Anything marked FIXED is in the working tree and committed. Check the original request again against `
    + `the corrected product, with fresh evidence, and record the result.\n\n`
    + directMessage(prompt, reportRel);
}

/** The run itself: execute, observe, record — in that order, one scenario at a time. */
function runMessage(prompt: string, planRel: string, reportRel: string, inPlace: boolean): string {
  const where = inPlace
    // Continued where it lives: that is where its history is, and where the people who wrote it look.
    ? `The document is "${planRel}", and it is BOTH the plan and the report — record each result in it, in `
      + `place, next to the scenario it belongs to. Do not create a second file.\n\n`
      + `Read it first: some scenarios already have results, established by someone else with evidence they `
      + `gathered. Do not re-run those and do not rewrite them. Continue from the first one with no result.\n\n`
    : `The test plan is "${planRel}". Work through its scenarios IN ORDER, and record each result in `
      + `"${reportRel}" — with its evidence — before you start the next one.\n\n`
      + `Create the report if it is not there. If it IS there, this is a resumed session: read it first and `
      + `continue from the first scenario that has no result. Do not re-run what is already recorded, and do `
      + `not rewrite results someone else established.\n\n`;
  return `${prompt}\n\n`
    + where
    + `Before the first scenario, check what the plan says must be running. If it is not up, tell the `
    + `developer which command to run and ask them to confirm — then wait. Never start it yourself.\n\n`
    + `When a scenario needs an eye on the screen, describe exactly what to look at and ask the developer what `
    + `they see. Their answer is the evidence; record it as theirs.\n\n`
    + handOffRule;
}

/**
 * Where the developer is actually looking.
 *
 * The tester writes the scenario into the document and then asks the developer to carry it out "as listed
 * above" — but the document is a file on a branch, and the developer is at a terminal. Measured live: two
 * rounds of "share your observation per the 5 items above", answered with "the steps aren't in the chat?".
 * Writing the document is not telling anyone.
 */
const handOffRule =
  `The developer sees the chat and nothing else. The document you are writing is NOT on their screen, so a `
  + `request that points at it — "the steps above", "the items listed" — asks them to follow something they `
  + `cannot see. When you need them to carry out a scenario, pass the actions to \`ask_user\` in \`steps\`, one `
  + `action per entry, and put in \`question\` what they should report back.`;


/** Two rounds is a loop; a third is a conversation the developer should be having instead. */
export const MAX_FIX_ROUNDS = 2;

/**
 * Sizes each finding, fixes what is a fix, and asks before spending more than that.
 *
 * The escalation is where the user's judgement belongs and nowhere else: a contained change happens in front
 * of them and they see it, but a brainstorm or a spec is a different order of cost and interrupts the test
 * session they are in the middle of. Deciding that silently is how a verification turns into an afternoon.
 */
async function handleFindings(
  opts: { deps: ReviewDeps; workdir: string; askUser: AskUser; note?: (text: string) => void },
  found: Finding[],
): Promise<string[]> {
  const done: string[] = [];
  for (const f of found) {
    const t = await triageFinding(opts.deps, opts.workdir, f);
    if (t.depth !== "task") {
      const answer = await opts.askUser(
        `${describeEscalation(f, t)}\n\nStart that now, or leave it in the report and carry on testing?`,
        { options: [
          { label: "Leave it — carry on testing", description: "It stays as an open finding; you can start it after the session." },
          { label: "Start it now", description: "The test session pauses while it is designed and built." },
        ] },
      );
      if (!/start it now/i.test(answer.trim())) {
        opts.note?.(`📌 Left open: **${f.title}** — ${t.reason}`);
        done.push(`${f.title} — left open, to be handled separately (${t.reason})`);
        continue;
      }
      /**
       * Deliberately not run here.
       *
       * Brainstorm and spec-and-plan are the upstream pipeline, and starting it from inside a verification
       * would nest one long interactive flow inside another — with the developer's environment running and a
       * half-finished report on disk. Saying plainly what to do next is worth more than an automation that
       * loses the session.
       */
      opts.note?.(`📋 **${f.title}** needs ${t.depth === "brainstorm" ? "a design decision" : "a spec and a plan"}. `
        + `Finish or stop this session, then ask for it as its own piece of work — the finding and its evidence are in the report.`);
      done.push(`${f.title} — needs its own piece of work; not fixed in this session`);
      continue;
    }
    opts.note?.(`🔧 Fixing: **${f.title}** — ${t.reason}`);
    // Taken BEFORE: the report is half-written and the session's memory is modified, and neither belongs in
    // a commit titled after the fix.
    const before = await dirtyPaths(defaultGitRunner, opts.workdir);
    const res = await runFix(opts.deps, opts.workdir, f, `fix-${done.length + 1}`);
    const changed = res.fixed ? await commitFix(opts.workdir, f, before) : [];
    /**
     * The fix landed; its description must not still say what the code used to do.
     *
     * This lane changes real product code and was the one that never refreshed — measured on the project it
     * runs against, 78 traces described code that had moved on, 24 of them committed within three days.
     */
    await refreshAfterChange({
      cwd: opts.workdir, files: changed, provider: opts.deps.provider,
      models: opts.deps.roleRegistry.chainFor("tracer", 0), signal: opts.deps.signal,
      ...(opts.note ? { note: opts.note } : {}),
    });
    opts.note?.(describeFix(res));
    done.push(res.fixed ? `${f.title} — FIXED` : `${f.title} — NOT fixed (${res.notes.join("; ") || "see above"})`);
  }
  return done;
}

/** What the tester is told when it is handed back the session after a fix. */
function resumeMessage(activeRel: string, reportRel: string, inPlace: boolean, done: string[]): string {
  return `The findings you reported have been dealt with:\n${done.map((d) => `- ${d}`).join("\n")}\n\n`
    + `Anything marked FIXED has been changed in the working tree and committed. Re-check the scenarios those `
    + `findings affected — against the corrected product, with fresh evidence — and record the result. Then `
    + `carry on from where you were.\n\n`
    + `Update each finding's OWN entry in the report as you re-check it: FIXED and verified, with the evidence `
    + `you just gathered, or still OPEN and what you saw this time. A finding left reading OPEN after it was `
    + `fixed is as wrong as one marked fixed that was not — the entry is what anyone reads later.\n\n`
    + `Anything NOT fixed stays in the report as an open finding. Do not fix it yourself, and do not fail a `
    + `scenario for it unless the scenario itself does not pass.\n\n`
    + runMessage("", activeRel, reportRel, inPlace);
}

/**
 * Runs the verification, in place.
 *
 * Two phases, because they fail differently. Writing the plan is research — what does this work do, and how
 * would anyone tell? Running it is observation, and it needs the environment up and the developer present. A
 * run that already has a plan skips straight to the second, which is what makes a stopped session resumable.
 */
export async function runVerify(opts: {
  /** ReviewDeps, not TaskCycleDeps: a finding is fixed by the same implement→review→accept cycle the pipeline uses. */
  deps: ReviewDeps;
  workdir: string;
  prompt: string;
  title: string;
  askUser: AskUser;
  note?: (text: string) => void;
  /** The user's own language — the tester asks questions and writes to them. See src/engine/language.ts. */
  language?: string;
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

  const findings = new FindingQueue();
  const dirRel = relative(workdir, paths.dir);
  const planRel = relative(workdir, paths.plan);
  const reportRel = relative(workdir, paths.report);
  const tools = testerTools(deps, askUser, findings);
  /**
   * The project's rules about verification and evidence.
   *
   * Measured on the constitution this was built for: "evidence is mandatory — database rows and log records"
   * and "the agent NEVER starts or stops the environment" are both principles the tester had never been shown.
   */
  const law = deps.home
    ? await constitutionNote({ ...deps, home: deps.home, note: opts.note }, workdir, { role: "tester", title })
    : "";

  /**
   * The locate step runs unless THIS run already settled the question.
   *
   * "Is there a plan?" used to be `existsSync` on one path, and a project with 237 test documents was told it
   * had none. So the question is now asked properly, by the tester, over the places the project actually keeps
   * them — and the answer is remembered, in the plan it wrote or the pointer it left, so a resumed session
   * does not ask again.
   */
  const settled = (): string | undefined => {
    const pointed = readPointer(paths.report);
    if (pointed && existsSync(join(workdir, pointed))) return pointed;
    return existsSync(paths.plan) ? planRel : undefined;
  };

  let active = settled();
  if (!active) {
    const docDirs = testDocDirs(await trackedFiles(workdir));
    opts.note?.(docDirs.length
      ? `🧪 Looking for an existing test document — this project keeps them in ${docDirs.map((d) => `\`${d}\``).join(", ")}.`
      : `🧪 Looking for an existing test document for this work.`);
    await runTester(deps, workdir, tools, planMessageFor(prompt, planRel, reportRel, dirRel, docDirs), opts.language, law, prompt);
    active = settled();
  }

  /**
   * No document, and none needed: the request IS the scenario.
   *
   * "Confirm from the screenshot that the description renders raw HTML instead of three lines" already says
   * what to check and what the answer should look like. Demanding a plan document first was a ceremony
   * around work that was fully specified — and the tester, correctly, refused to invent one and asked for
   * the file instead. Measured live: six calls, a minute, and "No test plan was found or written — nothing
   * was verified" for a question that could have been answered.
   *
   * A plan is for "run the tests for this pull request". A named check is its own plan.
   */
  const direct = !active;
  if (direct) opts.note?.(`🧪 No test document, and none needed — the request names what to check. Verifying it directly.`);

  const inPlace = !!active && active !== planRel;
  opts.note?.(inPlace
    ? `🧪 Continuing \`${active}\` in place — it already holds results, and a second document beside it would disagree with it.`
    : `🧪 Verifying against \`${active}\`.`);
  /**
   * Verify → fix → verify, until the tester stops raising findings.
   *
   * The tester never fixes anything; it reports. So a finding is the one thing that has to interrupt the
   * scenarios, and the loop exists because fixing is only half of it — the point is to fold the fix BACK into
   * the verification, so the scenario it affected is run again against the corrected product.
   *
   * Bounded, because a fix that keeps producing findings is a conversation, not a loop.
   */
  let round = 0;
  let message = direct ? directMessage(prompt, reportRel) : runMessage(prompt, active!, reportRel, inPlace);
  for (;;) {
    await runTester(deps, workdir, tools, message, opts.language, law, prompt);
    const found = findings.drain();
    if (!found.length || round >= MAX_FIX_ROUNDS) {
      if (found.length) opts.note?.(`⚠️ ${found.length} finding(s) left unfixed — ${MAX_FIX_ROUNDS} rounds of fixing is the limit for one session.`);
      break;
    }
    round++;
    const done = await handleFindings(opts, found);
    message = direct ? directResumeMessage(prompt, reportRel, done) : resumeMessage(active!, reportRel, inPlace, done);
  }
  return {
    dir: dirRel,
    planPath: active ?? reportRel,
    // In-place: the results are in the document itself, and the folder holds the pointer to it.
    reportPath: inPlace ? active! : reportRel,
    planWritten: true,
    reportWritten: inPlace || existsSync(paths.report),
  };
}

/** What the user is told when it ends. */
/**
 * `workdir` is what makes the location honest.
 *
 * The result's `dir` is RELATIVE — `specs/004-…` — so asking `sessionBase` about it always answered
 * "not in a session", and the report told the user their work was "uncommitted, in your working tree" while
 * the branch beside it read `hc/05-Aug-2026-WEDNESDAY_01/base`. Two claims in one line, one of them wrong,
 * and the wrong one sends someone looking in a directory that does not have the file.
 */
export function describeVerify(r: VerifyResult, branch: string, workdir?: string): string {
  if (!r.planWritten) {
    return `⚠️ No test plan was found or written — nothing was verified.`;
  }
  const head = r.reportWritten
    ? `🧪 Test report: \`${r.reportPath}\``
    : `⚠️ The plan is at \`${r.planPath}\`, but no report was written — nothing was recorded.`;
  // A run that continued a document elsewhere must SAY where, or the folder's pointer is the only clue and
  // the person reading this goes looking in the wrong place.
  const inPlace = r.reportPath !== `${r.dir}/test-report.md` && r.reportWritten;
  const where = inPlace
    ? `Continued in place, where its history already was. \`${r.dir}\` holds a pointer to it.`
    : `Everything this run produced is in \`${r.dir}\`.`;
  /**
   * "in your working tree" was true when verify ran in place, and stopped being true when it moved to a
   * branch. The path is the honest answer either way: a report in a session worktree is not somewhere the
   * user can `git status` into.
   */
  const base = sessionBase(workdir !== undefined ? resolve(workdir, r.dir) : r.dir);
  const seat = base === undefined
    ? `On branch \`${branch}\` — uncommitted, in your working tree.`
    : `On branch \`${branch}\`, in the worktree at \`${base}\` — review it there, then merge it in.`;
  return `${head}\n\n${where} ${seat}`;
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
