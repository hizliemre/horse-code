import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { RoleRegistry } from "../agent/roles.js";
import { readOnlyRegistry } from "./reviewer.js";
import { memoryHints, emitBatchInjection, reinforceUsed } from "./memory-inject.js";
import type { TaskCycleDeps, Verdict } from "./task-types.js";
import type { ReviewerConfig, RoleConfig } from "../config/config.js";
import type { ProgressEvent } from "./progress.js";
import { taskDiff, describeDiff } from "./task-diff.js";
import { telemetry } from "../obs/telemetry.js";
import { BATCH_TOOLS_NOTE } from "./task-types.js";

/** Which artifact is under review — each stage has its OWN finder lenses and its own framing. */
export type ReviewStage = "spec" | "plan" | "code";

export interface ReviewDeps extends TaskCycleDeps {
  // Two-stage review: the TEAM (many single-angle lenses) produces findings; the COUNCIL (a small strong panel)
  // votes on contested work. The team's lenses differ PER STAGE — a spec, a plan and code can each only answer
  // their own kind of question — so both the configs and their round-robin registries are keyed by stage.
  teams: Record<ReviewStage, ReviewerConfig[]>;
  teamRegistries: Record<ReviewStage, RoleRegistry>;
  councilRegistry: RoleRegistry;
  council: ReviewerConfig[];
  /** Wall-clock ceiling per reviewer; defaults to REVIEW_TIMEOUT_MS. Lowered by tests, raisable for slow models. */
  reviewTimeoutMs?: number;
}
/**
 * One selectable answer. A bare string is still accepted everywhere and means `{ label }` — the richer form is
 * for choices the user cannot judge from a one-line label alone (which approach to build, which trade-off to
 * accept), where the `preview` is rendered beside the list as the cursor moves.
 */
export interface AskChoice {
  label: string;
  /** One line under the label: what this option means, or what happens if it is chosen. */
  description?: string;
  /** Longer content shown in a panel next to the list while this option is focused. */
  preview?: string;
}

/** Structured choices for a question → the TUI renders a selectable checkbox/radio list. */
export interface AskOpts { options?: (string | AskChoice)[]; multiSelect?: boolean }

/** Normalizes the mixed option form to {@link AskChoice}. */
export function asChoice(o: string | AskChoice): AskChoice {
  return typeof o === "string" ? { label: o } : o;
}
export type AskUser = (question: string, opts?: AskOpts) => Promise<string>;

export type Severity = "critical" | "medium" | "low";
export interface Finding { severity: Severity; note: string }
export interface Assessment { name: string; findings: Finding[]; recommendation: "approve" | "revise" }
export const AssessmentSchema = z.object({
  // Each concern is tagged with a severity so the UI can show critical/medium/low counts per reviewer.
  findings: z.array(z.object({ severity: z.enum(["critical", "medium", "low"]), note: z.string() })).default([]),
  recommendation: z.enum(["approve", "revise"]),
});

/** Count a reviewer's findings by severity → the {C,M,L} shown after its model in the live panel. */
function severityCounts(a: Assessment): { critical: number; medium: number; low: number } {
  const c = { critical: 0, medium: 0, low: 0 };
  for (const f of a.findings) c[f.severity]++;
  return c;
}
/** The one-line result stamped on a team member's live row: verdict + severity counts. */
function memberStatus(a: Assessment): string {
  const c = severityCounts(a);
  return `${a.recommendation === "approve" ? "APPROVE" : "REJECT"} · C:${c.critical} M:${c.medium} L:${c.low}`;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 3, medium: 2, low: 1 };
/** The worst severity anywhere in the team's findings ("none" if the doc is clean). */
function worstSeverity(assessments: Assessment[]): Severity | "none" {
  let worst: Severity | "none" = "none";
  for (const a of assessments) for (const f of a.findings) {
    if (worst === "none" || SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst]) worst = f.severity;
  }
  return worst;
}
/** Findings at the given severities, flattened and labelled with the lens that raised them (provenance). */
function findingNotes(assessments: Assessment[], stage: ReviewStage, severities: readonly Severity[]): string[] {
  return assessments.flatMap((a) => a.findings.filter((f) => severities.includes(f.severity))
    .map((f) => `[${stage}][${f.severity}] ${a.name}: ${f.note}`));
}

/** The team's medium/low findings, flattened → carried to the next stage instead of forcing another round. */
function nonBlockingNotes(assessments: Assessment[], stage: ReviewStage): string[] {
  return findingNotes(assessments, stage, ["medium", "low"]);
}

/**
 * The brief handed to a revision.
 *
 * A decider's rationale is a VERDICT ("the data model is underspecified"); a lens finding is the DEFECT
 * ("plan.md §4 defines Todo but never the parent/child FK"). Sending only the verdicts left the author to guess
 * at the defect, so the same finding survived the rewrite, the blocking signature never changed, and the loop
 * stalled on "not converging". Defects first — they are what actually has to change — reasons after.
 */
function reviseBrief(findings: string[], reasons: string[]): string[] {
  return [...findings, ...reasons.map((r) => `[decision] ${r}`)];
}

/** A council vote as revision input: the member's name is kept so the author can weigh who objected and why. */
function voteReasons(votes: CouncilVote[]): string[] {
  return votes.filter((v) => v.vote === "revise").map((v) => `${v.name}: ${v.rationale}`);
}

/** Stable identity of each BLOCKING finding → lets convergence be judged by content instead of by count. */
function blockingSignatures(assessments: Assessment[]): Set<string> {
  const out = new Set<string>();
  for (const a of assessments) for (const f of a.findings) {
    if (f.severity === "critical") out.add(`${a.name}::${f.note.trim().toLowerCase().replace(/\s+/g, " ")}`);
  }
  return out;
}

/** Total findings across the team at a given severity → used in the council-handoff note. */
function severityTotal(assessments: Assessment[], sev: Severity): number {
  return assessments.reduce((n, a) => n + a.findings.filter((f) => f.severity === sev).length, 0);
}

export interface CouncilVote { name: string; vote: "pass" | "revise"; rationale: string }
export const CouncilVoteSchema = z.object({
  vote: z.enum(["pass", "revise"]),
  rationale: z.string(),
});

export interface JudgeDecision { decision: "pass" | "revise" | "ask-human"; feedback: string[]; question: string }
export const JudgeSchema = z.object({
  decision: z.enum(["pass", "revise", "ask-human"]),
  feedback: z.array(z.string()),
  question: z.string(),
});

export interface ReviewOutcome {
  approved: boolean;
  /** Medium/low findings that were NOT worth another revision round — carried forward to the next stage as
   *  known, non-blocking context (they are never silently dropped). */
  deferred?: string[];
}

/** What the artifact IS, and which questions therefore belong to this stage (vs a later one). */
const STAGE_FRAMING: Record<ReviewStage, string> = {
  spec:
    "You are reviewing a SPECIFICATION: it states WHAT the product must do and WHY, written for business " +
    "stakeholders. By design it MUST NOT contain implementation detail (languages, frameworks, APIs, storage " +
    "mechanics, code structure) — those decisions belong to the LATER plan stage.\n" +
    "OUT OF SCOPE here: implementation questions (which storage engine, how concurrency is handled, API shapes, " +
    "libraries, performance tactics). Do NOT ask the spec to answer them and do NOT treat their absence as a " +
    "defect — that is the plan's job. (The one exception is the abstraction-leak lens, which flags implementation " +
    "detail that HAS leaked into the spec.)\n" +
    "SEVERITY: \"critical\" = the spec contradicts itself, or a capability the user explicitly requested is missing " +
    "or impossible as written. \"medium\" = a real ambiguity or gap that would likely cause the wrong thing to be " +
    "built. \"low\" = wording/polish. \"The spec does not specify <technical mechanism>\" is NOT a finding.",
  plan:
    "You are reviewing an IMPLEMENTATION PLAN: it states HOW the already-approved spec will be built (technical " +
    "context, architecture, data model, contracts, project structure). This is the right place for technology and " +
    "mechanism decisions.\n" +
    "OUT OF SCOPE here: re-litigating WHAT the product should do (the spec is approved), and reviewing code that " +
    "does not exist yet.\n" +
    "SEVERITY: \"critical\" = the plan cannot deliver a specified requirement, or has a design flaw that would have " +
    "to be undone later. \"medium\" = a design weakness worth fixing now. \"low\" = preference/polish.",
  code:
    "You are reviewing CODE that implements one approved task.\n" +
    "OUT OF SCOPE here: re-litigating the approved spec or plan, and demanding refactors beyond this task's scope.\n" +
    "SEVERITY: \"critical\" = breaks correctness, security or data integrity, or the task's requirement is not " +
    "actually implemented. \"medium\" = a real defect or risk worth fixing now. \"low\" = style/polish.",
};

/**
 * Tool-call budget for one reviewer. A lens reads the artifact, greps a few things and writes its findings —
 * a healthy pass is under ten turns. The 50-turn default was never meant for this: it let a single lens explore
 * for a quarter of an hour while the whole round waited on it. Exceeding it is no longer fatal (the lens is
 * asked to submit what it has), so this is a budget rather than a cliff.
 */
export const REVIEW_MAX_TURNS = 15;

/**
 * Wall-clock ceiling for one reviewer. The team runs in parallel, so a round lasts as long as its SLOWEST
 * member: without this, one stuck reviewer holds every finished one hostage indefinitely (observed: three
 * lenses done in 2-8 min, four still running at 17.5 min with no way out).
 */
export const REVIEW_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * A per-reviewer signal that trips on the job being cancelled OR on the reviewer running out of time. Both
 * are aborts, but they mean different things: the caller distinguishes them by checking which one fired.
 */
function reviewerSignal(deps: ReviewDeps): AbortSignal {
  return AbortSignal.any([deps.signal, AbortSignal.timeout(deps.reviewTimeoutMs ?? REVIEW_TIMEOUT_MS)]);
}

/** Applies to every stage: judge the work against what was ASKED FOR, not against an idealized system. */
const SCOPE_RULE =
  "Scale your expectations to the REQUESTED scope: do not hold a small, simple product to enterprise-grade " +
  "standards it never asked for. Demanding unrequested capability is itself a defect (scope creep), not a finding.";

function teamPrompt(stage: ReviewStage, perspective: string): string {
  return (
    `You are a review TEAM member for the ${stage.toUpperCase()} stage. Your lens: ${perspective}.\n\n` +
    `${STAGE_FRAMING[stage]}\n\n${SCOPE_RULE}\n\n` +
    `Produce a list of findings — each with a severity ("critical"/"medium"/"low") and a concise note — plus a ` +
    `recommendation: "approve" (nothing blocking from your lens) or "revise". Report only genuine issues: an empty ` +
    `findings list with "approve" is the correct answer for work that is good enough for THIS stage. ` +
    `Write findings in ENGLISH — they are a technical review artifact, not a conversation with the user, ` +
    `so they stay English regardless of any conversational-language rule.`
  );
}

function councilPrompt(perspective: string): string {
  return (
    `You are a member of the review COUNCIL — a small, senior decision panel. Your judgment lens: ${perspective}.\n\n` +
    `You are given the work under review AND the review team's findings. Weigh them and cast a single vote: ` +
    `"pass" (ship it as-is for this stage) or "revise" (it needs changes first), with a concise rationale. ` +
    `Judge it against what was ASKED FOR and against what THIS stage is responsible for — a spec is not expected ` +
    `to answer implementation questions, and a plan is not expected to re-state requirements. Do not nitpick: vote ` +
    `"revise" only for issues that genuinely warrant another pass. ${SCOPE_RULE} ` +
    `Write the rationale in ENGLISH regardless of any conversational-language rule.`
  );
}

/** Converts reviewer configs into a round-robin RoleRegistry (name → role with the given prompt builder). */
function buildReviewerRegistry(reviewers: ReviewerConfig[], prompt: (p: string) => string): RoleRegistry {
  const roles: Record<string, RoleConfig> = {};
  for (const r of reviewers) roles[r.name] = { models: r.models, systemPrompt: prompt(r.perspective) };
  return new RoleRegistry(roles);
}

/** A stage's finder lenses → each produces severity-tagged findings + an approve/revise recommendation. */
export function buildTeamRegistry(stage: ReviewStage, team: ReviewerConfig[]): RoleRegistry {
  return buildReviewerRegistry(team, (p) => teamPrompt(stage, p));
}
/** The small decider council → each casts a pass/revise vote with a rationale. */
export function buildCouncilRegistry(council: ReviewerConfig[]): RoleRegistry {
  return buildReviewerRegistry(council, councilPrompt);
}

/** The message of a thrown value, trimmed for a one-line status. */
function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 160 ? `${m.slice(0, 159)}…` : m;
}

/**
 * Runs a structured reviewer and, if its ENTIRE model chain fails, heals the role and retries once.
 *
 * A fully spent chain used to be terminal for the session: the role reported "no response" on every later
 * round while the same dead model sat in other roles' chains waiting to fail them too. Healing quarantines
 * what died, re-assigns this role AND every role still holding those models, then retries here so the current
 * round still gets a real review instead of an UNVERIFIED hole.
 *
 * A TIMEOUT is deliberately excluded: the model was reachable, only slow, and quarantining it would throw away
 * a working model over a latency problem.
 */
async function runWithHealing<T>(
  deps: ReviewDeps, role: string, id: string, opts: RoleAgentOptions, schema: z.ZodType<T>,
  signal: AbortSignal, emit: (ev: ProgressEvent) => void,
): Promise<T> {
  try {
    return await runStructuredRole(opts, schema);
  } catch (e) {
    if (deps.signal.aborted || signal.aborted || !deps.rechainRole) throw e;
    const chain = await deps.rechainRole(role, errText(e));
    if (!chain?.length) throw e;
    emit({ kind: "note", text: `🔁 \`${role}\` lost its whole model chain — retrying on \`${chain[0]}\`.` });
    emit({ kind: "agent-model", id, model: chain[0] }); // the row must name who is actually working now
    return runStructuredRole({ ...opts, model: chain[0], fallbacks: chain.slice(1) }, schema);
  }
}

/**
 * Runs a STAGE's team in parallel; each lens reviews the target read-only and produces a named assessment.
 * `target` is the doc path (spec/plan) or a description of the code change; `request` is the user's original
 * ask — the scope anchor every lens judges against (without it a lens optimizes toward an idealized system).
 */
export async function runTeam(
  deps: ReviewDeps, stage: ReviewStage, workdir: string, target: string, request?: string,
  emit: (ev: ProgressEvent) => void = () => {},
  carried: Assessment[] = [],
): Promise<Assessment[]> {
  const registry = deps.teamRegistries[stage];
  // A lens that APPROVED last round already said its dimension is fine; re-running all of them every round is
  // the single biggest cost in the loop. Carry those verdicts forward and re-review only the ones that asked
  // for changes. (If nothing is carried, this is a normal full pass.)
  const carriedByName = new Map(carried.map((a) => [a.name, a]));
  const team = deps.teams[stage].filter((c) => !carriedByName.has(c.name));
  if (carriedByName.size) {
    emit({ kind: "note", text: `↩︎ ${carriedByName.size} lens(es) approved last round — carrying their verdict; re-reviewing ${team.length}.` });
  }
  const scope = request ? `\n\nThe user's original request (the scope you must judge against):\n"""\n${request}\n"""` : "";
  const what = stage === "code" ? `Review the code for: ${target}.` : `Review the "${target}" document.`;
  /**
   * Fetched ONCE and given to all fifteen lenses.
   *
   * Each of them used to be told "review the code for X" and handed read/grep/glob to go and find it — in
   * parallel, each burning its own budget on the same search. Measured over one session: of 85 review
   * failures, 29 said the lens "could not complete" and 13 that its tool-call budget was exhausted. Only four
   * were about the code. Every one of the other 42 sent the task back for a full re-implementation, which is
   * a twenty-minute attempt spent to answer a question the review had not managed to ask.
   */
  const diff = stage === "code" && deps.baseRef ? await taskDiff(workdir, deps.baseRef) : "";
  const evidence = stage === "code" ? `\n\n${describeDiff(diff)}` : "";
  // What earlier runs learned, addressed to each lens by name. A lens is the narrowest audience in the system:
  // "the concurrency lens keeps missing X" is precisely the kind of lesson that must reach one agent and no other.
  const query = `${stage} ${target} ${request ?? ""}`;
  const hintsByLens = new Map(team.map((c) => [c.name, memoryHints(deps, query, { role: c.name, silent: true })]));
  // Surface each team member as a live sub-agent (they run in parallel) so the user sees the review happening.
  emit({ kind: "agents", agents: team.map((c) => ({ id: `team:${c.name}`, title: `team: ${c.name}`, model: registry.peekModel(c.name) })) });
  emitBatchInjection(deps, `team:${stage}`, [...hintsByLens.values()]); // one aggregate note, not one per lens
  try {
    const fresh = await Promise.all(
      team.map(async (c): Promise<Assessment> => {
        const tok = { promptTokens: 0, completionTokens: 0 }; // this member's own token spend (like the shimmer)
        /**
         * A lens with no model is a MISSING lens, not a broken review.
         *
         * `resolve` throws for a role that was never assigned one, and it used to throw here where nothing
         * caught it: the rejection took down the whole `Promise.all` and the entire review died in 48ms,
         * failing the task with it. Reported the same way any other unusable lens is — its dimension is
         * unverified, the council must adjudicate it — so the review is degraded rather than absent.
         */
        let resolved;
        try {
          resolved = registry.resolve(c.name);
        } catch (e) {
          emit({ kind: "agent-result", id: `team:${c.name}`, status: "⚠ UNVERIFIED (no model)" });
          return { name: c.name, recommendation: "revise", findings: [{ severity: "critical",
            note: `The "${c.name}" lens has no model assigned (${errText(e)}) — this dimension is UNVERIFIED. ` +
              `Run \`/roles adjust\` to give every review lens a model.` }] };
        }
        const hints = hintsByLens.get(c.name)!;
        const id = `team:${c.name}`;
        let serving = registry.peekModel(c.name); // the row starts on the chain head; corrected as calls land
        const ask = { role: "user" as const, content: `${what} Evaluate it through your lens.${scope}${evidence}` };
        const signal = reviewerSignal(deps);
        const opts: RoleAgentOptions = {
          provider: deps.provider, ...resolved,
          // Fifteen lenses reading the same change, one file per turn each, is the same waste multiplied.
          systemPrompt: resolved.systemPrompt + BATCH_TOOLS_NOTE,
          tools: readOnlyRegistry(deps, { propose: true }),
          // A slide down the chain is a visible event: rename the row, then let the registry's own note run.
          onFallback: (from, to, why) => { serving = to; emit({ kind: "agent-model", id, model: to }); resolved.onFallback?.(from, to, why); },
          proposeMemory: (t, k) => deps.proposeMemory?.(t, k, c.name) ?? false,
          messages: hints.message ? [{ role: "user", content: hints.message }, ask] : [ask],
          permission: deps.permission, approve: deps.approve, cwd: workdir, signal,
          maxTurns: REVIEW_MAX_TURNS,
          // Stream the running total onto this member's row as each call lands — a row that shows only a
          // ticking clock for minutes says nothing about what it is costing while it is still costing it.
          onUsage: (u) => {
            tok.promptTokens += u.promptTokens;
            tok.completionTokens += u.completionTokens;
            // The usage report names the model that actually served the call, so a chain slide (inside the
            // agent loop OR across the structured chain walk) shows up here rather than staying invisible.
            if (u.model && u.model !== serving) { serving = u.model; emit({ kind: "agent-model", id, model: serving }); }
            emit({ kind: "agent-usage", id, ...tok });
          },
        };
        try {
          const r = await runWithHealing(deps, c.name, id, opts, AssessmentSchema, signal, emit);
          const a: Assessment = { name: c.name, findings: r.findings, recommendation: r.recommendation };
          // Credit the hints this lens actually echoed back in its findings → they rank higher next time.
          reinforceUsed(deps, hints.ids, r.findings.map((f) => f.note).join(" "), c.name);
          // Stream THIS member's result onto its live row the moment it lands (verdict + severity counts + its
          // token spend) — early finishers show immediately instead of the whole batch appearing at once. No chat
          // note here; the consolidated summary is written once, when the whole team has reported (runReviewLoop).
          emit({ kind: "agent-result", id: `team:${c.name}`, status: memberStatus(a), ...tok });
          return a;
        } catch (e) {
          if (deps.signal.aborted) throw e; // genuine cancellation → propagate
          // Fail-SAFE, not fail-silent: a lens that can't complete its review leaves its dimension UNVERIFIED.
          // Silently dropping it would let the review approve a dimension NOBODY checked (e.g. correctness /
          // data-integrity). Return a BLOCKING critical finding instead → the shortcut can't pass over the gap
          // and the council must adjudicate it. (Root cause is usually an unavailable/misassigned model chain.)
          // A timeout is reported as such: "it never answered" and "it ran past three minutes" have different
          // fixes (a broken model chain vs. a lens that needs a cheaper model or a narrower artifact).
          const timedOut = signal.aborted;
          const why = timedOut
            ? `did not finish within its ${Math.round((deps.reviewTimeoutMs ?? REVIEW_TIMEOUT_MS) / 1000)}s budget`
            : `every model in its chain failed — ${errText(e)}`;
          emit({ kind: "agent-result", id: `team:${c.name}`, status: timedOut ? "⚠ UNVERIFIED (timed out)" : "⚠ UNVERIFIED (no response)", ...tok });
          return { name: c.name, recommendation: "revise", findings: [{ severity: "critical", note: `The "${c.name}" lens could not complete its review (${why}) — this dimension is UNVERIFIED and must be re-checked.` }] };
        }
      }),
    );
    return [...carried, ...fresh]; // carried approvals still count toward the consensus math
  } finally {
    emit({ kind: "agents", agents: [] }); // clear the live-agents panel when the team finishes
  }
}

/** A short digest of the team's findings, handed to the council/judge as the evidence to weigh. */
function findingsDigest(assessments: Assessment[]): string {
  return assessments.map((a) => {
    const list = a.findings.map((f) => `[${f.severity}] ${f.note}`).join("; ") || "no findings";
    return `- ${a.name} (${a.recommendation}): ${list}`;
  }).join("\n");
}

/** The consolidated team result written to chat once ALL members have reported (verdict + counts per member). */
function teamSummaryNote(assessments: Assessment[], label: string): string {
  const approve = assessments.filter((a) => a.recommendation === "approve").length;
  const lines = assessments.map((a) => {
    const c = severityCounts(a);
    const counts = c.critical || c.medium || c.low ? ` — C:${c.critical} M:${c.medium} L:${c.low}` : "";
    return `- \`${a.name}\` ${a.recommendation === "approve" ? "✓ APPROVE" : "✗ REJECT"}${counts}`;
  }).join("\n");
  return `**Team review of the ${label}** — ${approve}/${assessments.length} approve:\n${lines}`;
}

/**
 * Runs the COUNCIL in parallel: each member weighs the doc + the team's findings and votes pass/revise with a
 * rationale. Returns the votes; the caller tallies them (a 4/5-style supermajority decides, else the judge).
 */
export type CouncilQuestion =
  | "blocking"  // "is this good enough to ship as-is?" — the default, used while blocking findings remain
  | "deferral"; // "only non-critical findings are left: defer them, or is one genuinely blocking after all?"

export async function runCouncil(
  deps: ReviewDeps, stage: ReviewStage, workdir: string, target: string, assessments: Assessment[],
  request?: string, emit: (ev: ProgressEvent) => void = () => {}, question: CouncilQuestion = "blocking",
): Promise<CouncilVote[]> {
  const digest = findingsDigest(assessments);
  const scope = request ? `\n\nThe user's original request:\n"""\n${request}\n"""` : "";
  const subject = stage === "code" ? `the code for: ${target}` : `the "${target}" ${stage}`;
  // The deciders judge the same change the lenses did; making them hunt for it is the same waste.
  const councilDiff = stage === "code" && deps.baseRef ? await taskDiff(workdir, deps.baseRef) : "";
  const councilEvidence = stage === "code" ? `\n\n${describeDiff(councilDiff)}` : "";
  // The deferral question is deliberately calibrated: without it a pile of "medium" findings always reads as
  // "revise", which is what turns the loop into endless polish. The council still holds the judgment — it can
  // promote a mislabelled finding to blocking — but "it could be clearer" is explicitly not a reason to revise.
  const ask = question === "deferral"
    ? `\n\nNOTE: this work has ALREADY been revised once and NO critical findings remain — only medium/low ones. ` +
      `Decide: vote "pass" to hand it to the next stage and DEFER those findings (they are recorded and carried ` +
      `forward, not dropped), or vote "revise" ONLY if one of them would genuinely cause the wrong thing to be ` +
      `built or shipped despite its label. Wanting it clearer, tighter or more complete is NOT a reason to revise.`
    : "";
  const hintsByMember = new Map(deps.council.map((c) => [c.name, memoryHints(deps, `${stage} ${target} ${request ?? ""}`, { role: c.name, silent: true })]));
  emit({ kind: "agents", agents: deps.council.map((c) => ({ id: `council:${c.name}`, title: `council: ${c.name}`, model: deps.councilRegistry.peekModel(c.name) })) });
  emitBatchInjection(deps, "council", [...hintsByMember.values()]);
  try {
    const results = await Promise.all(
      deps.council.map(async (c): Promise<CouncilVote> => {
        const tok = { promptTokens: 0, completionTokens: 0 };
        // A decider with no model votes the conservative way, exactly as one that cannot answer does.
        let resolved;
        try {
          resolved = deps.councilRegistry.resolve(c.name);
        } catch (e) {
          emit({ kind: "agent-result", id: `council:${c.name}`, status: "⚠ UNVERIFIED (no model)" });
          return { name: c.name, vote: "revise" as const,
            rationale: `The "${c.name}" decider has no model assigned (${errText(e)}) — counted as revise to be safe.` };
        }
        const hints = hintsByMember.get(c.name)!;
        const id = `council:${c.name}`;
        let serving = deps.councilRegistry.peekModel(c.name);
        const vote = { role: "user" as const, content: `You are reviewing ${subject} (the ${stage} stage), plus the team's findings:\n${digest}${scope}${ask}${councilEvidence}\n\nCast your vote (pass/revise) with a rationale.` };
        const signal = reviewerSignal(deps);
        const opts: RoleAgentOptions = {
          provider: deps.provider, ...resolved,
          // Fifteen lenses reading the same change, one file per turn each, is the same waste multiplied.
          systemPrompt: resolved.systemPrompt + BATCH_TOOLS_NOTE,
          tools: readOnlyRegistry(deps, { propose: true }),
          // A slide down the chain is a visible event: rename the row, then let the registry's own note run.
          onFallback: (from, to, why) => { serving = to; emit({ kind: "agent-model", id, model: to }); resolved.onFallback?.(from, to, why); },
          proposeMemory: (t, k) => deps.proposeMemory?.(t, k, c.name) ?? false,
          messages: hints.message ? [{ role: "user", content: hints.message }, vote] : [vote],
          permission: deps.permission, approve: deps.approve, cwd: workdir, signal,
          maxTurns: REVIEW_MAX_TURNS,
          // Stream the running total onto this member's row as each call lands — a row that shows only a
          // ticking clock for minutes says nothing about what it is costing while it is still costing it.
          onUsage: (u) => {
            tok.promptTokens += u.promptTokens;
            tok.completionTokens += u.completionTokens;
            // The usage report names the model that actually served the call, so a chain slide (inside the
            // agent loop OR across the structured chain walk) shows up here rather than staying invisible.
            if (u.model && u.model !== serving) { serving = u.model; emit({ kind: "agent-model", id, model: serving }); }
            emit({ kind: "agent-usage", id, ...tok });
          },
        };
        try {
          const r = await runWithHealing(deps, c.name, id, opts, CouncilVoteSchema, signal, emit);
          reinforceUsed(deps, hints.ids, r.rationale, c.name);
          // Stream this vote onto its live row as it lands (no chat note — the tally is one action from the caller).
          emit({ kind: "agent-result", id: `council:${c.name}`, status: r.vote === "pass" ? "PASS" : "REVISE", ...tok });
          return { name: c.name, vote: r.vote, rationale: r.rationale };
        } catch (e) {
          if (deps.signal.aborted) throw e; // genuine cancellation → propagate
          // Fail-SAFE: a decider that can't vote counts as a conservative REVISE (we can't confirm the doc is
          // fine), never silently dropped — otherwise a shrunk council could accidentally reach a "pass".
          const timedOut = signal.aborted;
          emit({ kind: "agent-result", id: `council:${c.name}`, status: timedOut ? "⚠ UNVERIFIED (timed out)" : "⚠ UNVERIFIED (no response)", ...tok });
          return { name: c.name, vote: "revise", rationale: `The "${c.name}" decider could not vote (${timedOut ? "timed out" : `chain failed — ${errText(e)}`}) — counted as revise to be safe.` };
        }
      }),
    );
    return results;
  } finally {
    emit({ kind: "agents", agents: [] });
  }
}

/**
 * Judge = the FINAL link: called only when the council can't reach a supermajority (a split vote). It weighs the
 * team findings AND the council's split votes, then makes the call (pass/revise/ask-human).
 */
export type JudgeQuestion =
  | "contested" // the council split on this round → break the tie
  | "final";    // the loop is stuck/exhausted → the judge is the LAST authority before the user is involved

export async function runJudge(
  deps: ReviewDeps, stage: ReviewStage, workdir: string, target: string, assessments: Assessment[], votes: CouncilVote[],
  request?: string, emit: (ev: ProgressEvent) => void = () => {}, question: JudgeQuestion = "contested",
  rounds = 0,
): Promise<JudgeDecision> {
  const resolved = deps.roleRegistry.resolve("judge");
  const findings = findingsDigest(assessments);
  const council = votes.map((v) => `- ${v.name}: ${v.vote} — ${v.rationale}`).join("\n");
  const subject = stage === "code" ? `The code for "${target}"` : `The "${target}" ${stage}`;
  // The FINAL question is what makes this system autonomous: rather than handing a stuck review to the user,
  // the strongest model rules on it. "ask-human" is reserved for decisions only the user can actually make
  // (a product/scope choice), never for "this is hard" or "the reviewers disagree".
  const ask = question === "final"
    ? `This review is STUCK: ${rounds} revision round(s) have run and the same blocking findings keep surviving, ` +
      `or the round budget is spent. You are the LAST authority before the user is involved.\n` +
      `Rule decisively:\n` +
      `- "pass" — the work is good enough for THIS stage; remaining findings are not real blockers (preferred if true).\n` +
      `- "revise" — one more TARGETED attempt is genuinely worth it; say exactly what must change.\n` +
      `- "ask-human" — ONLY if the blocker is a product/scope decision that you cannot make on the user's behalf. ` +
      `Difficulty, reviewer disagreement or a desire for more polish are NOT reasons to ask the user.`
    : `You are the final decider on this contested round. Judge it against what was asked for and against what ` +
      `THIS stage is responsible for (a spec answers WHAT/WHY, a plan answers HOW, code is the implementation). ` +
      `Decide (pass/revise/ask-human).`;
  const hints = memoryHints(deps, `${stage} ${target} ${request ?? ""}`, { role: "judge" });
  const brief = { role: "user" as const, content:
    `${subject} is contested (the ${stage} review stage).${request ? `\n\nThe user's original request:\n"""\n${request}\n"""` : ""}\n\n` +
    `The review team's findings:\n${findings}\n\n` +
    `The council's votes:\n${council}\n\n${ask}` };
  const opts: RoleAgentOptions = {
    provider: deps.provider, ...resolved,
    tools: readOnlyRegistry(deps, { propose: true }),
    proposeMemory: (t, k) => deps.proposeMemory?.(t, k, "judge") ?? false,
    messages: hints.message ? [{ role: "user", content: hints.message }, brief] : [brief],
    permission: deps.permission, approve: deps.approve, cwd: workdir, signal: reviewerSignal(deps),
    maxTurns: REVIEW_MAX_TURNS,
  };
  let d: JudgeDecision;
  try {
    d = await runStructuredRole(opts, JudgeSchema);
    reinforceUsed(deps, hints.ids, d.feedback.join(" "), "judge");
  } catch (e) {
    if (deps.signal.aborted) throw e; // genuine cancellation → propagate
    // The judge never produced a structured ruling (no submit, model error). Don't crash the job — default to
    // the safe, conservative decision: revise. The next round re-reviews; the review can still converge/escalate.
    emit({ kind: "note", text: `🔨 **Judge** couldn't produce a ruling — defaulting to revise (re-reviewing).` });
    return { decision: "revise", feedback: ["The judge could not reach a structured decision; revising and re-reviewing to be safe."], question: "" };
  }
  // ACTION-level note (the judge's ruling), not its reasoning. The revise details ride the revise step, not chat.
  emit({ kind: "note", text: d.decision === "pass" ? `🔨 **Judge** ruled: approve.`
    : d.decision === "revise" ? `🔨 **Judge** ruled: revise → sending it back for changes.`
    : `🔨 **Judge** needs your input to break the tie.` });
  return d;
}

/**
 * §6 review loop: team findings → (consensus? pass) → council vote → (supermajority? decide) → judge.
 * revise→revise(feedback)→retry, ask-human→askUser→feedback→revise→retry. Once maxRounds is exhausted, a
 * final human decision (approve / keep reviewing / stop).
 */
/** A strong TEAM majority (this share of "approve") passes without convening the council — one lens's nitpick
 *  shouldn't force a full council vote, which matters with a large (15-lens) team. */
const TEAM_CONSENSUS = 0.7;
/** The council's decisive share: with 5 members this is a 4/5 supermajority. ≥ this share of one side decides;
 *  anything short of it (a split) escalates to the judge, the final link. */
const COUNCIL_SUPERMAJORITY = 0.8;

/** Tally council votes → "pass" (supermajority pass), "revise" (supermajority revise), or "split" (→ judge). */
function tallyCouncil(votes: CouncilVote[]): "pass" | "revise" | "split" {
  if (votes.length === 0) return "split"; // no council configured → let the judge decide
  const needed = Math.ceil(votes.length * COUNCIL_SUPERMAJORITY);
  const pass = votes.filter((v) => v.vote === "pass").length;
  if (pass >= needed) return "pass";
  if (votes.length - pass >= needed) return "revise";
  return "split";
}

export interface ReviewLoopOpts {
  stage: ReviewStage;          // which artifact is under review → picks the lens set + the framing
  workdir: string;
  target: string;              // doc path (spec/plan) or a description of the code change
  request?: string;            // the user's original ask — the scope anchor every reviewer judges against
  revise: (feedback: string[]) => Promise<void>;
  askUser: AskUser;
  maxRounds: number;
  emit?: (ev: ProgressEvent) => void;
  language?: string;           // the user's language (from the refiner) → localize the human-facing escalation
}

export async function runReviewLoop(deps: ReviewDeps, o: ReviewLoopOpts): Promise<ReviewOutcome> {
  const { stage, workdir, target, request, revise, askUser, maxRounds } = o;
  const emit = o.emit ?? (() => {});
  const language = o.language;
  const label = stage;
  let round = 0;
  let prevSignatures = new Set<string>(); // convergence is measured by finding CONTENT, not by count
  let deferralVetoUsed = false; // the council may override a deferral ONCE; after that mediums always defer
  let batches = 1;              // a "batch" is maxRounds rounds; the judge may grant one more
  const MAX_BATCHES = 2;
  let lastAssessments: Assessment[] | undefined; // fed to the judge's final ruling
  let lastVotes: CouncilVote[] = [];
  // Outer loop: run a batch of up to `maxRounds` council/judge rounds; if none pass, escalate to the human,
  // who may approve as-is, ask for MORE review rounds (another batch), or stop. Only "stop" ends without approval.
  for (;;) {
    for (let i = 0; i < maxRounds; i++, round++) {
      // ACTION narrative only: the chat tracks WHO is deciding and the hand-offs (team → council → judge),
      // not what each agent produced. Members' raw findings/votes stay out of the chat flow by design.
      // Safety net: never review a document that does not exist. Every lens would (correctly) report it as a
      // blocking finding and the revision could not fix a file that was never written — the whole round budget
      // would burn for nothing. Fail immediately with a message that names the real problem.
      if (stage !== "code" && !existsSync(isAbsolute(target) ? target : join(workdir, target))) {
        emit({ kind: "note", text: `⚠️ **${label} not found** at \`${target}\` — nothing to review. The authoring phase produced no file.` });
        return { approved: false };
      }
      // Only the lenses that asked for changes re-review: an approving lens already cleared its dimension, and
      // re-running the whole team every round was the loop's dominant cost. If the previous round was a clean
      // sweep (every lens approved but the council still said revise), nothing is carried — the team's read was
      // wrong, so it re-reviews in full.
      const approvedLast = (lastAssessments ?? []).filter((a) => a.recommendation === "approve");
      const carry = round > 0 && approvedLast.length < (lastAssessments?.length ?? 0) ? approvedLast : [];
      emit({ kind: "note", text: `🔍 **Reviewing the ${label}** (round ${round + 1}) — the team (${deps.teams[stage].length - carry.length}) is discussing it…` });
      const assessments = await runTeam(deps, stage, workdir, target, request, emit, carry);
      lastAssessments = assessments; // every exit path (shortcut, deferral, council) must leave this current
      // The whole team has reported → write the consolidated result to chat (per-member verdict + counts).
      if (assessments.length) emit({ kind: "note", text: teamSummaryNote(assessments, label) });
      const approve = assessments.filter((a) => a.recommendation === "approve").length;
      const crit = severityTotal(assessments, "critical");
      const med = severityTotal(assessments, "medium");

      // TIERED BAR. Round 1 is the thorough pass: a critical OR medium finding blocks the shortcut (one lens is
      // the SOLE authority on its dimension, so a majority "approve" must never wave through a serious finding).
      // From round 2 on, only CRITICAL blocks: "medium" findings on a doc are effectively inexhaustible — any
      // document can always be clarified further — so keeping them blocking turns the loop into endless polish
      // (observed: ~10 rounds of "clarify …" commits). Their notes are carried forward instead of re-revised.
      if (round === 0) {
        const clean = crit === 0 && med === 0;
        if (assessments.length && clean && approve / assessments.length >= TEAM_CONSENSUS) {
          emit({ kind: "note", text: `✅ **Team** — clean (no critical/medium findings), ${approve}/${assessments.length} approve → the ${label} is approved.` });
          return { approved: true };
        }
      } else if (crit === 0) {
        // No criticals left — but whether the remaining medium/low findings are worth another round is a
        // JUDGMENT call, and the council is what horse-code has for judgment. Ask it the calibrated deferral
        // question instead of deciding by rule; it can still promote a mislabelled finding to blocking.
        const deferred = nonBlockingNotes(assessments, stage);
        if (!deferred.length) {
          emit({ kind: "note", text: `✅ **Team** — nothing left to fix → the ${label} is approved.` });
          return { approved: true };
        }
        if (deferralVetoUsed) { // the council already had its say on these; don't re-litigate them forever
          emit({ kind: "note", text: `✅ **Team** — only medium/low findings remain → the ${label} is approved; ${deferred.length} note(s) carried forward.` });
          return { approved: true, deferred };
        }
        emit({ kind: "note", text: `👥 **Team** — no criticals, ${deferred.length} medium/low finding(s) → asking the **council** whether to defer them or fix one now.` });
        const dVotes = await runCouncil(deps, stage, workdir, target, assessments, request, emit, "deferral");
        const dTally = tallyCouncil(dVotes);
        const dPass = dVotes.filter((v) => v.vote === "pass").length;
        if (dTally === "pass") {
          emit({ kind: "note", text: `✅ **Council** voted to defer (${dPass}/${dVotes.length} pass) → the ${label} is approved; ${deferred.length} note(s) carried forward.` });
          return { approved: true, deferred };
        }
        // The council says one of these IS blocking despite its label → one more revision, then it's settled.
        const dJudged = dTally === "revise"
          ? { decision: "revise" as const, feedback: voteReasons(dVotes), question: "" }
          : await runJudge(deps, stage, workdir, target, assessments, dVotes, request, emit);
        if (dJudged.decision === "pass") {
          emit({ kind: "note", text: `✅ **Judge** approved the ${label}; ${deferred.length} note(s) carried forward.` });
          return { approved: true, deferred };
        }
        emit({ kind: "note", text: `🔄 **Council** found a non-critical finding worth fixing → one more revision of the ${label}.` });
        deferralVetoUsed = true; // bounded: the council gets exactly one veto over a deferral
        // The deferred findings ARE the subject of this veto → hand them over, not just the verdict.
        await revise(reviseBrief(deferred, dJudged.feedback));
        continue;
      }

      // Convergence, measured by CONTENT not by count: if every blocking finding is one we already saw last
      // round, the revision achieved nothing and more rounds won't either. A changed set (2 fixed, 2 new) is
      // still progress, so the loop continues. Detected here but acted on AFTER the council has had its say.
      const sig = blockingSignatures(assessments);
      const stuck = round > 0 && sig.size > 0 && [...sig].every((x) => prevSignatures.has(x));
      prevSignatures = sig;

      // The defects a revision actually has to fix, per the SAME tiered bar the round is judged by: round 1
      // weighs medium too, later rounds only critical. Handed to the author alongside the deciders' reasons.
      const blockingFindings = findingNotes(assessments, stage, round === 0 ? ["critical", "medium"] : ["critical"]);

      // Contested → the team hands the decision to the council, which weighs the findings and VOTES. Say WHY:
      // a serious finding surfaced, or the team just split on approval.
      const reason = crit || med
        ? `surfaced ${crit} critical / ${med} medium finding(s)`
        : `is split (${approve}/${assessments.length} approve)`;
      emit({ kind: "note", text: `👥 **Team** ${reason} → handed the decision to the **council** (${deps.council.length} members vote).` });
      const votes = await runCouncil(deps, stage, workdir, target, assessments, request, emit);
      const tally = tallyCouncil(votes);
      const passVotes = votes.filter((v) => v.vote === "pass").length;

      let decision: JudgeDecision;
      if (tally === "pass") {
        // Approved with findings still on the table → they are deferred, never silently dropped.
        const deferred = nonBlockingNotes(assessments, stage);
        emit({ kind: "note", text: `✅ **Council** voted to approve (${passVotes}/${votes.length} pass) → the ${label} is approved.${deferred.length ? ` ${deferred.length} note(s) carried forward.` : ""}` });
        return { approved: true, deferred };
      } else if (tally === "revise") {
        emit({ kind: "note", text: `🔄 **Council** voted to revise (${votes.length - passVotes}/${votes.length}) → sending the ${label} back for changes.` });
        decision = { decision: "revise", feedback: voteReasons(votes), question: "" };
      } else {
        // Split vote → the council defers the final call to the judge.
        emit({ kind: "note", text: `🔨 **Council** was split (${passVotes}/${votes.length} pass) → deferred the final decision to the **judge**.` });
        decision = await runJudge(deps, stage, workdir, target, assessments, votes, request, emit);
        if (decision.decision === "pass") {
          const deferred = nonBlockingNotes(assessments, stage);
          emit({ kind: "note", text: `✅ **Judge** approved the ${label}.${deferred.length ? ` ${deferred.length} note(s) carried forward.` : ""}` });
          return { approved: true, deferred };
        }
      }

      lastVotes = votes;

      let feedback = decision.feedback;
      if (decision.decision === "ask-human") {
        emit({ kind: "note", text: `❓ Judge needs your input: ${decision.question}` });
        const answer = await askUser(decision.question);
        feedback = [...feedback, `Human answer: ${answer}`];
      }
      // Same blocking findings as last round → revising again is provably futile; go straight to the judge's
      // final ruling instead of burning the rest of the batch.
      if (stuck) {
        emit({ kind: "note", text: `⚠️ **Not converging** — the same blocking findings survived the last revision. Handing it to the **judge** for a final ruling.` });
        break;
      }
      emit({ kind: "note", text: `🔄 Revising the ${label} with ${blockingFindings.length} finding(s) + the deciders' reasons…` });
      await revise(reviseBrief(blockingFindings, feedback));
    }

    // The batch is over (rounds spent, or the loop was provably stuck). THE JUDGE RULES BEFORE ANY HUMAN — this
    // is what keeps the system autonomous: the strongest model decides, and only IT can decide that a question
    // genuinely belongs to the user.
    if (lastAssessments) {
      const finalRuling = await runJudge(deps, stage, workdir, target, lastAssessments, lastVotes, request, emit, "final", round);
      if (finalRuling.decision === "pass") {
        const deferred = nonBlockingNotes(lastAssessments, stage);
        emit({ kind: "note", text: `✅ **Judge** ruled the ${label} good enough for this stage.${deferred.length ? ` ${deferred.length} note(s) carried forward.` : ""}` });
        return { approved: true, deferred };
      }
      if (finalRuling.decision === "revise" && batches < MAX_BATCHES) {
        batches++;
        emit({ kind: "note", text: `🔄 **Judge** ruled one more targeted attempt is worth it → another ${maxRounds} round(s).` });
        await revise(reviseBrief(findingNotes(lastAssessments, stage, ["critical"]), finalRuling.feedback));
        prevSignatures = new Set(); // a judge-directed attempt is a fresh start for convergence tracking
        continue;
      }
      // Judge says the user must decide (or the batch budget is spent) → now, and only now, involve the human.
      if (finalRuling.decision === "ask-human" && finalRuling.question) {
        emit({ kind: "note", text: `❓ **Judge** needs a decision only you can make: ${finalRuling.question}` });
      }
    }
    // Escalation — localized to the user's language (this string is code-generated, not from an LLM, so the
    // "respond in <language>" rule wouldn't reach it). SELECTABLE so the intent is unambiguous — including the
    // "keep reviewing" option the user needs to run more rounds WITHOUT approving.
    const [q, approveLabel, continueLabel, stopLabel] = language === "Turkish"
      ? [`${round} revizyon turunda onaylanmadı. Ne yapmak istersin?`, "Mevcut haliyle onayla", `Review'a devam et (${maxRounds} tur daha)`, "Durdur"]
      : [`Not approved after ${round} revision rounds. What now?`, "Approve as-is", `Keep reviewing (${maxRounds} more rounds)`, "Stop"];
    const answer = (await askUser(q, { options: [approveLabel, continueLabel, stopLabel] })).trim();
    if (answer === continueLabel || /^\s*(review|more|daha|başka|tur|round)/i.test(answer)) continue; // another batch of rounds
    if (answer === stopLabel || /^\s*(stop|durdur|iptal|cancel|hay[ıi]r|no)\s*$/i.test(answer)) return { approved: false };
    // Anything else that reads as approval → proceed as-is. (Bare "devam" is intentionally NOT here: with the
    // explicit "keep reviewing" option present, its meaning is ambiguous — a plain selection covers approval.)
    if (answer === approveLabel || /^\s*(approve|yes|onayla|onay|evet|kabul|tamam|ok)\s*$/i.test(answer)) return { approved: true };
    // Unrecognized free text → safest default is to keep reviewing (never force-approve or silently abandon).
    emit({ kind: "note", text: language === "Turkish" ? "🔄 Anlaşılamadı — review'a devam ediliyor." : "🔄 Unclear answer — continuing the review." });
  }
}

/**
 * The lenses that run on EVERY change, however small.
 *
 * They answer the four questions a change cannot be waved through without: is it right, is it what was
 * asked for, is it tested, is it safe. The other eleven are quality dimensions — performance, observability,
 * accessibility, API surface — and a three-line edit to a config file does not have room to get them wrong.
 */
export const CORE_CODE_LENSES = [
  "code-correctness", "code-plan-conformance", "code-tests", "code-security",
];

/**
 * Below this many changed lines a task gets the core lenses only.
 *
 * The task list for one small app included "Install all exact dependencies", "Create package.json scripts"
 * and "Add Material M3 theme to angular.json" — three-line edits, each convening fifteen reviewers and then
 * an acceptance gate. The per-task overhead is fixed and the task count is the multiplier; this makes the
 * overhead follow the size of what is actually being reviewed.
 */
export const SMALL_CHANGE_LINES = 40;

/** How many lines a diff adds or removes — the size a review should be scaled to. */
export function changedLines(diff: string): number {
  let n = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue; // file headers, not content
    if (line.startsWith("+") || line.startsWith("-")) n++;
  }
  return n;
}

/**
 * The lenses to convene for a change of this size.
 *
 * Falls back to the whole team whenever the size is unknown (no diff) or the core names are not present in a
 * customised team — an unreviewed task is a far worse outcome than an over-reviewed one.
 */
export function lensesFor(team: ReviewerConfig[], diff: string): ReviewerConfig[] {
  if (!diff.trim() || changedLines(diff) > SMALL_CHANGE_LINES) return team;
  const core = team.filter((c) => CORE_CODE_LENSES.includes(c.name));
  return core.length ? core : team;
}

/**
 * CODE-stage review: runs the code lens team on one task's implementation, then the same
 * team → council → judge escalation as the doc stages — but SINGLE-SHOT (no revise loop here: the task cycle's
 * escalation ladder owns retries). Returns the task-cycle Verdict, with the blocking findings as notes.
 */
export async function runCodeReview(
  deps: ReviewDeps, workdir: string, taskTitle: string, request?: string,
  emit: (ev: ProgressEvent) => void = () => {},
  attempt = 0, // how many times this task has already been reviewed+revised → drives the tiered bar
): Promise<Verdict> {
  // Scaled to the change: the review a three-line config edit needs is not the review a new module needs.
  const diff = deps.baseRef ? await taskDiff(workdir, deps.baseRef) : "";
  const team = lensesFor(deps.teams.code, diff);
  const scaled = team.length < deps.teams.code.length;
  telemetry().event("decision.review_scale", {
    "hc.decision": "review_scale",
    "hc.changed_lines": changedLines(diff),
    "hc.lenses": team.length,
    "hc.lenses.full": deps.teams.code.length,
    "hc.scaled": scaled,
  });
  emit({ kind: "note", text:
    `🔍 **Reviewing the code** for "${taskTitle}" — ${team.length} lens(es)` +
    `${scaled ? ` (${changedLines(diff)} changed lines — the core set)` : ""} discussing it…` });
  const assessments = await runTeam({ ...deps, teams: { ...deps.teams, code: team } }, "code", workdir, taskTitle, request, emit);
  if (assessments.length) emit({ kind: "note", text: teamSummaryNote(assessments, "code") });

  const approve = assessments.filter((a) => a.recommendation === "approve").length;
  const crit = severityTotal(assessments, "critical");
  const med = severityTotal(assessments, "medium");

  // TIERED BAR, same rule the doc stages use — here an "attempt" is the loop, not a review round. The FIRST
  // review of a task is the thorough pass (critical OR medium blocks); once the code has already been revised
  // for reviewer notes, only CRITICAL blocks. Otherwise inexhaustible medium nitpicks would keep failing the
  // task and each retry costs a full re-implementation, which is far more expensive than a doc revision.
  if (attempt === 0) {
    if (assessments.length && crit === 0 && med === 0 && approve / assessments.length >= TEAM_CONSENSUS) {
      emit({ kind: "note", text: `✅ **Team** — clean (no critical/medium findings), ${approve}/${assessments.length} approve → the code passed.` });
      return { verdict: "pass", notes: [] };
    }
  } else if (crit === 0) {
    const deferred = nonBlockingNotes(assessments, "code");
    if (!deferred.length) {
      emit({ kind: "note", text: `✅ **Team** — nothing left to fix → the code passed.` });
      return { verdict: "pass", notes: [] };
    }
    // Same judgment call as the doc stages: whether a leftover medium is really blocking is the COUNCIL's call,
    // not a hard rule. A "pass" defers them to the PR revision pass; a "revise" sends the task back once more.
    emit({ kind: "note", text: `👥 **Team** — no criticals, ${deferred.length} medium/low finding(s) → asking the **council** whether to defer them.` });
    const dVotes = await runCouncil(deps, "code", workdir, taskTitle, assessments, request, emit, "deferral");
    const dTally = tallyCouncil(dVotes);
    if (dTally === "pass") {
      emit({ kind: "note", text: `✅ **Council** voted to defer → the code passed; ${deferred.length} note(s) go to the PR revision pass.` });
      return { verdict: "pass", notes: [], deferred };
    }
    if (dTally === "revise") {
      emit({ kind: "note", text: `🔄 **Council** found a non-critical finding worth fixing now → sending the code back.` });
      return { verdict: "fail", notes: deferred };
    }
    const dJudge = await runJudge(deps, "code", workdir, taskTitle, assessments, dVotes, request, emit);
    if (dJudge.decision === "pass") return { verdict: "pass", notes: [], deferred };
    return { verdict: "fail", notes: dJudge.feedback.length ? dJudge.feedback : deferred };
  }

  const reason = crit || med ? `surfaced ${crit} critical / ${med} medium finding(s)` : `is split (${approve}/${assessments.length} approve)`;
  emit({ kind: "note", text: `👥 **Team** ${reason} → handed the decision to the **council** (${deps.council.length} members vote).` });
  const votes = await runCouncil(deps, "code", workdir, taskTitle, assessments, request, emit);
  const tally = tallyCouncil(votes);
  const passVotes = votes.filter((v) => v.vote === "pass").length;

  // Blocking findings become the reviewer notes the implementer must address on the next attempt.
  const blocking = assessments.flatMap((a) => a.findings.filter((f) => f.severity !== "low").map((f) => `[${f.severity}] ${a.name}: ${f.note}`));

  if (tally === "pass") {
    emit({ kind: "note", text: `✅ **Council** voted to approve (${passVotes}/${votes.length} pass) → the code passed.` });
    return { verdict: "pass", notes: [] };
  }
  if (tally === "revise") {
    emit({ kind: "note", text: `🔄 **Council** voted to revise (${votes.length - passVotes}/${votes.length}) → sending the code back.` });
    return { verdict: "fail", notes: blocking.length ? blocking : votes.filter((v) => v.vote === "revise").map((v) => v.rationale) };
  }
  emit({ kind: "note", text: `🔨 **Council** was split (${passVotes}/${votes.length} pass) → deferred the final decision to the **judge**.` });
  const d = await runJudge(deps, "code", workdir, taskTitle, assessments, votes, request, emit);
  if (d.decision === "pass") return { verdict: "pass", notes: [] };
  return { verdict: "fail", notes: d.feedback.length ? d.feedback : blocking };
}
