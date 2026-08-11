import { spawn } from "node:child_process";
import type { Board } from "../board/board.js";
import type { WorktreeManager, WorktreeSession, TaskWorktree } from "../worktree/manager.js";
import type { EscalationDeps } from "./escalation.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runToCompletion } from "../agent/loop.js";
import { runReviewer } from "./reviewer.js";
import { memoryHints, reinforceTouched } from "./memory-inject.js";
import { traceRootRel, TRACE_INDEX, parseTraceIndex, mergeTraceIndexes, serializeTraceIndex } from "./trace.js";
import { contextTools } from "./task-types.js";
import { ToolRegistry } from "../tools/registry.js";
import { readFileTool } from "../tools/read.js";
import { buildRememberTool } from "../tools/remember.js";
import { writeFileTool } from "../tools/write.js";
import { editFileTool } from "../tools/edit.js";
import { grepTool } from "../tools/grep.js";
import { globTool } from "../tools/glob.js";
import { buildSkillTool } from "../skills/apply.js";
import { callSignal, LONG_CALL_MS } from "../agent/deadline.js";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";

export interface ConflictDeps extends EscalationDeps {
  manager: Pick<WorktreeManager, "unmergedFiles" | "commitMerge" | "abortMerge" | "resolveWithBase">
    /** Optional: the combining resolutions need both sides. A manager without them falls back cleanly. */
    & Partial<Pick<WorktreeManager, "conflictSide" | "resolveWith">>;
}

export type ConflictResult = { status: "resolved" } | { status: "unresolved"; task: TaskWorktree };

/** Resolver toolset: file editing (read/write/edit/grep/glob) + skill — NO SHELL. */
/**
 * Resolving a conflict is a text edit on files git has already named. It is not an investigation.
 *
 * The resolver used to carry grep, glob, the skill loader and the code-graph tools as well, and it spent its
 * whole budget using them: measured live, a three-file conflict ended with
 * `conflict:resolve-failed: maximum turn count exceeded (50)` — fifty turns, and the merge was abandoned with
 * the task's review already passed. Tools it does not need are turns it will spend.
 */
function resolverRegistry(remember?: (fact: string) => void): ToolRegistry {
  const r = new ToolRegistry();
  // A conflict is where two intentions met; what settled it is worth the next agent knowing.
  r.register(buildRememberTool(remember));
  r.register(readFileTool);
  r.register(writeFileTool);
  r.register(editFileTool);
  return r;
}

/**
 * A turn budget that scales with the work: a few turns per conflicted file, with a floor.
 *
 * The default of fifty was both too many (it let the resolver wander) and, for a large conflict, potentially
 * too few. Tying it to the file count says what the job actually is.
 */
export const RESOLVE_TURNS_PER_FILE = 6;
export const RESOLVE_TURNS_MIN = 12;
export function resolveTurnBudget(fileCount: number): number {
  return Math.max(RESOLVE_TURNS_MIN, fileCount * RESOLVE_TURNS_PER_FILE);
}

/**
 * The conflicted regions themselves, handed over rather than hunted for.
 *
 * Each hunk is the text between `<<<<<<<` and `>>>>>>>`, which is the whole of what has to be decided. With
 * these in the prompt the resolver can edit straight away instead of spending turns reading files to find
 * markers it was already told about.
 */
export function conflictHunks(text: string, maxChars = 4000): string {
  const out: string[] = [];
  const re = /^<<<<<<<[^\n]*\n([\s\S]*?)^>>>>>>>[^\n]*$/gm;
  let m: RegExpExecArray | null;
  let used = 0;
  while ((m = re.exec(text)) !== null) {
    const hunk = m[0];
    if (used + hunk.length > maxChars) { out.push("… (further conflicts in this file, not shown)"); break; }
    used += hunk.length;
    out.push(hunk);
  }
  return out.join("\n\n");
}

/** Whether any of the given files still contains a conflict marker (`<<<<<<<`). */
export async function hasConflictMarkers(baseWorktree: string, files: string[]): Promise<boolean> {
  for (const f of files) {
    try {
      const content = await readFile(join(baseWorktree, f), "utf8");
      if (content.includes("<<<<<<<")) return true;
    } catch {
      // the file may have been deleted during resolution (delete/modify) → treat as no marker
    }
  }
  return false;
}

/**
 * Resolves a conflict in the mid-merge base worktree with the OPERATIONAL agent (the project's version-control
 * owner): it edits the conflicted files to remove markers + merge both sides → deterministic marker scan +
 * code-reviewer → commitMerge. If unresolved after N rounds, abortMerge + ask a human. (The `git merge` itself
 * stays deterministic; only the intelligent conflict resolution is delegated to the agent.)
 */
/**
 * Files a package manager writes and a person never should. Their conflicts are resolved by re-running the
 * tool, not by choosing lines.
 */
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/;

/**
 * How each lockfile is re-derived from its manifest.
 *
 * Taking the base's copy settles the conflict but leaves the file stale: the branch's OWN dependency is in
 * `package.json` and not in the lockfile it just inherited. The manifest is the source of truth, so the fix
 * is to run the one command that regenerates the other — which is also the command a person would run, and
 * the one thing the resolver could never do, having been given read/write/edit and no shell at all.
 *
 * Lockfile-only where the ecosystem offers it: the conflict is about the dependency GRAPH, and downloading
 * packages to settle it would turn a second into minutes.
 *
 * `yarn.lock` is deliberately absent. The command differs between Yarn 1 and Yarn 2+ and the file itself
 * does not say which, and running the wrong one rewrites the lockfile in the other format — worse than the
 * conflict. It keeps the base's copy, and the note says so.
 */
const REGENERATE: { file: RegExp; cmd: string[] }[] = [
  { file: /package-lock\.json$|npm-shrinkwrap\.json$/, cmd: ["npm", "install", "--package-lock-only"] },
  { file: /pnpm-lock\.yaml$/, cmd: ["pnpm", "install", "--lockfile-only"] },
  { file: /Cargo\.lock$/, cmd: ["cargo", "generate-lockfile"] },
  { file: /poetry\.lock$/, cmd: ["poetry", "lock", "--no-update"] },
  { file: /Gemfile\.lock$/, cmd: ["bundle", "lock"] },
  { file: /composer\.lock$/, cmd: ["composer", "update", "--lock"] },
  { file: /go\.sum$/, cmd: ["go", "mod", "tidy"] },
];

/** Ceiling for a regeneration. Long enough for a real dependency graph, short enough not to stall a wave. */
export const REGENERATE_TIMEOUT_MS = 180_000;

function runCmd(cmd: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const take = (d: Buffer): void => { if (out.length < 8_000) out += d.toString(); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill("SIGKILL"), REGENERATE_TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, out: e.message }); });
    child.on("close", (c) => { clearTimeout(timer); resolve({ ok: c === 0, out }); });
  });
}

/**
 * Regenerates one lockfile in place. Returns what to tell the user, or undefined when nothing was run.
 *
 * Best-effort by design: the base's copy is already staged, so a failure here leaves the merge resolvable
 * and the branch no worse off than before — just with a lockfile that a later install will correct.
 */
export async function regenerateLockfile(file: string, baseWorktree: string): Promise<string | undefined> {
  const rule = REGENERATE.find((r) => r.file.test(file));
  if (!rule) return undefined;
  const dir = join(baseWorktree, dirname(file));
  const r = await runCmd(rule.cmd, dir);
  return r.ok
    ? `regenerated with \`${rule.cmd.join(" ")}\``
    : `could not regenerate (\`${rule.cmd.join(" ")}\`: ${r.out.trim().split("\n").slice(-1)[0]?.slice(0, 120) ?? "failed"}) — `
      + `kept the base's copy; run it yourself before merging`;
}

/**
 * Settles the conflicts nobody has to think about, and reports what is left.
 *
 * Generated files are the ones a merge should never ask a person — or a model — about, and every merge into a
 * session base meets them: a task branch coming home and the project's own main branch coming in both bring
 * lockfiles and traces. Extracted so both callers get the same treatment; the judgement rounds below are what
 * differs between them, not this.
 *
 * Returns the files that still need judgement (`conflicted`) alongside the ones it settled (`generated`), so
 * the caller can tell "nothing left to decide" from "there was nothing generated".
 */
/**
 * Combines both sides of a conflicted trace index and stages the result. Returns how many entries it holds,
 * or undefined when either side is not an index — in which case the caller falls back to the normal path.
 */
async function mergeConflictedTraceIndex(
  deps: ConflictDeps,
  session: WorktreeSession,
  file: string,
): Promise<number | undefined> {
  if (!deps.manager.conflictSide || !deps.manager.resolveWith) return undefined;
  try {
    const ourText = await deps.manager.conflictSide(session, file, "ours");
    const theirText = await deps.manager.conflictSide(session, file, "theirs");
    if (ourText === undefined || theirText === undefined) return undefined;
    const ours = parseTraceIndex(ourText);
    const theirs = parseTraceIndex(theirText);
    if (!ours || !theirs) return undefined;
    const merged = mergeTraceIndexes(ours, theirs);
    await deps.manager.resolveWith(session, file, serializeTraceIndex(merged));
    return Object.keys(merged.traces).length;
  } catch {
    return undefined; // anything unexpected → the file is still conflicted, and still resolvable the long way
  }
}

export async function resolveGeneratedConflicts(
  deps: ConflictDeps,
  session: WorktreeSession,
  conflictedFiles: string[],
): Promise<{ conflicted: string[]; generated: string[] }> {
  const base = session.baseWorktree;
  /**
   * The trace index is neither merged by hand nor taken from one side. It is combined.
   *
   * It is a map from file to that file's trace, so two branches conflicting on it are two branches that traced
   * different files — the union is the answer, exactly, with no judgement involved. This runs first because
   * the whole point is to settle it before anything else looks at it.
   */
  const indexPath = `${traceRootRel().replace(/\\/g, "/")}/${TRACE_INDEX}`;
  const rest: string[] = [];
  let allConflicted = conflictedFiles;
  for (const f of allConflicted) {
    if (f !== indexPath) { rest.push(f); continue; }
    const merged = await mergeConflictedTraceIndex(deps, session, f);
    if (merged === undefined) { rest.push(f); continue; } // not parseable → let the normal path have it
    deps.note?.(`🗂️ \`${f}\` — trace index; combined both sides (${merged} entries).`);
  }
  allConflicted = rest;
  /**
   * A lockfile is not merged. It is regenerated.
   *
   * `package-lock.json` is the output of a resolver, not a document: its conflicts are thousands of lines of
   * machine-written JSON whose correct resolution is "run the package manager again". Handing that to a
   * model is asking it to do by hand what a program does exactly, and it fails the way that always fails —
   * measured on a real board, T006 conflicted on `toucan/package-lock.json` twice and both attempts ended
   * with "maximum turn count exceeded (12)", the task's own review already passed. Twelve turns, twice, on a
   * file nobody wrote.
   *
   * Taking OURS and regenerating is right because the base is where the other tasks' installs have already
   * landed: `T002` and `T003` both declared this file and merged before this one came back. What the branch
   * has to add is its own dependency, and the install re-derives that from the manifest.
   */
  /**
   * A trace is generated too, and conflicts on it are resolved the same way: by regenerating.
   *
   * Two branches both rewrote horse-code's own description of a source file — one because a task was told to
   * update the architecture doc, the other because the merge refresh re-derived it. Neither text is a
   * decision anybody made; both are accounts of the same code. Asking a model to reconcile two AI-written
   * prose descriptions is asking it to choose between paraphrases, and it went exactly as that goes —
   * measured live: three `conflict:resolve-attempt` rounds on one `.md`, the merge still unresolved, the
   * base stuck for five minutes.
   *
   * Taking the base's copy is enough because the refresh that runs straight after the merge re-derives it
   * from the source that just landed. The right answer is written a moment later, for free.
   */
  const isTrace = (f: string): boolean => {
    const root = traceRootRel().replace(/\\/g, "/");
    return f.startsWith(`${root}/`) && /\.[A-Za-z0-9]{1,5}\.md$/.test(f);
  };
  const generated = allConflicted.filter((f) => LOCKFILE.test(f) || isTrace(f));
  const lockfiles = allConflicted.filter((f) => LOCKFILE.test(f));
  const conflicted = allConflicted.filter((f) => !generated.includes(f));
  const traces = generated.filter((f) => !LOCKFILE.test(f));
  if (traces.length) {
    deps.note?.(`📝 ${traces.length} trace file(s) conflicted — taking the base's copy; the refresh after this `
      + `merge re-derives them from the code that just landed.`);
    for (const f of traces) {
      try { await deps.manager.resolveWithBase(session, f); } catch { /* the resolver will see it if this fails */ }
    }
  }
  if (lockfiles.length) {
    deps.note?.(`🔒 ${lockfiles.join(", ")} — generated file, taking the base's copy and regenerating rather `
      + `than merging it by hand.`);
    for (const f of lockfiles) {
      try {
        await deps.manager.resolveWithBase(session, f);
        // …and then re-derive it from the manifest, which is the part that makes the base's copy correct
        // rather than merely conflict-free.
        const said = await regenerateLockfile(f, base);
        if (said) deps.note?.(`   \`${f}\` — ${said}`);
        await deps.manager.resolveWithBase(session, f); // re-stage whatever the regeneration wrote
      } catch { /* the base's copy is already staged; the merge can proceed */ }
    }
  }
  return { conflicted, generated };
}

/**
 * The conflicted regions, read once and handed over — the resolver should not spend turns finding them.
 *
 * Measured live: a three-file conflict ended with "maximum turn count exceeded (50)", the merge abandoned
 * with the task's review already passed. The same lesson as the reviewers: handed, not hunted.
 */
export async function handedHunks(files: string[], cwd: string): Promise<string> {
  const parts: string[] = [];
  for (const f of files.slice(0, 10)) {
    try {
      const text = await readFile(join(cwd, f), "utf8");
      const hunks = conflictHunks(text);
      if (hunks) parts.push(`--- ${f}\n${hunks}`);
    } catch { /* unreadable → the resolver can still open it itself */ }
  }
  return parts.length ? `The conflicted regions:\n\n${parts.join("\n\n")}\n\n` : "";
}

/**
 * One round of the operational agent over a mid-merge worktree: remove every marker, keep both intents.
 *
 * The agent, its toolset and its turn budget are the same wherever a merge conflicts, so they live here
 * rather than in each caller — what a caller decides is how many rounds to allow and how to check the result.
 */
export async function runConflictResolver(
  deps: ConflictDeps,
  base: string,
  conflicted: string[],
  notes = "",
): Promise<void> {
  const op = deps.roleRegistry.resolve("operational");
  /**
   * What earlier runs learned about these FILES, before their two versions are merged by hand.
   *
   * Retrieved on the conflicted paths, which is the one query here that memory can answer well: memories
   * carry file anchors, and an anchor appearing in the query is the strongest signal the scorer has. A
   * file that conflicts repeatedly is exactly the file someone has already written down how to treat —
   * "this array is generated, take theirs", "these two lists must stay in the same order".
   */
  const hints = memoryHints(deps, conflicted.join(" "), { role: "operational", operations: true });
  const ask = { role: "user" as const, content:
    `A git merge left conflicts in the base worktree. Resolve them: for EACH file, remove all conflict ` +
    `markers (<<<<<<<, =======, >>>>>>>) and combine BOTH sides' changes so the intent of each is ` +
    `preserved (don't just pick one side unless the changes are truly incompatible). ` +
    `Conflicted files: ${conflicted.join(", ")}.\n\n${await handedHunks(conflicted, base)}${notes}` };
  const resolveOpts: RoleAgentOptions = {
    provider: deps.provider, ...op,
    tools: resolverRegistry(deps.rememberFact),
    messages: hints.message ? [{ role: "user", content: hints.message }, ask] : [ask],
    permission: deps.permission, approve: deps.approve, cwd: base, signal: deps.signal,
    perAttemptMs: LONG_CALL_MS, // each model in the chain gets its own clock — see RoleAgentOptions
    maxTurns: resolveTurnBudget(conflicted.length),
    // It is combining two sides of the user's own code; how it read the conflict is the thing to check.
    ...(deps.note ? { onSay: (t: string) => deps.note?.(`  ↳ ${t}`) } : {}),
  };
  await runToCompletion(resolveOpts);
  // Credited by the files it went to — the same signal the implementer is judged on.
  reinforceTouched(deps, hints.ids, conflicted, "operational");
}

export async function resolveMergeConflict(
  deps: ConflictDeps,
  session: WorktreeSession,
  board: Board,
  taskId: string,
  task: TaskWorktree,
): Promise<ConflictResult> {
  if (!board.get(taskId)) throw new Error(`resolveMergeConflict: unknown task: ${taskId}`);
  const rounds = Math.max(1, deps.rounds);
  const base = session.baseWorktree;
  const { conflicted, generated } =
    await resolveGeneratedConflicts(deps, session, await deps.manager.unmergedFiles(session));
  if (!conflicted.length && generated.length) {
    // Nothing left that needs judgement — the merge can be completed on the regenerated file alone.
    return { status: "resolved" };
  }
  deps.note?.(`🔀 Merge conflict in ${conflicted.join(", ")} — operational resolving…`);

  for (;;) {
    for (let i = 0; i < rounds; i++) {
      const card = board.get(taskId)!;
      const notes = card.reviewNotes.length
        ? `\nHints from the last attempt:\n${card.reviewNotes.map((n) => `- ${n}`).join("\n")}`
        : "";

      // The operational agent diagnoses + resolves the conflict (file edits only — no shell).
      await runConflictResolver(deps, base, conflicted, notes);
      board.appendStage(taskId, { role: "operational", action: "conflict:resolve-attempt" });

      // verify: deterministic marker scan + code-reviewer
      if (await hasConflictMarkers(base, conflicted)) {
        // reviewNotes = reason the last round failed (symmetric with the reviewer-fail branch: clear+set)
        board.clearReviewNotes(taskId);
        board.addReviewNote(taskId, `conflict markers still present: ${conflicted.join(", ")}`);
        continue;
      }
      const v = await runReviewer(deps, board.get(taskId)!, base);
      if (v.verdict === "pass") {
        await deps.manager.commitMerge(session, `chore: resolve merge conflict — ${card.title}`);
        board.appendStage(taskId, { role: "operational", action: "conflict:merged" });
        deps.note?.(`🔖 chore: resolve merge conflict — ${card.title}`);
        return { status: "resolved" };
      }
      board.clearReviewNotes(taskId);
      for (const n of v.notes) board.addReviewNote(taskId, n);
    }

    // rounds exhausted, base still mid-merge → ask a human
    const decision = await deps.askHuman({
      card: board.get(taskId)!,
      verdict: { verdict: "fail", notes: [`merge conflict not resolved in ${rounds} rounds`] },
    });
    if (decision.action === "retry") {
      board.clearReviewNotes(taskId);
      for (const n of decision.notes) board.addReviewNote(taskId, n);
      continue;
    }
    // accept/abandon → abort (no commit with markers/left incomplete)
    await deps.manager.abortMerge(session);
    board.appendStage(taskId, { role: "human", action: "conflict:aborted" });
    deps.note?.(`⚠ Merge conflict could not be resolved after ${rounds} rounds — aborted.`);
    return { status: "unresolved", task };
  }
}
