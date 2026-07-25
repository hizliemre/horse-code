import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { RoleRegistry } from "../agent/roles.js";
import { readOnlyRegistry } from "./reviewer.js";
import type { TaskCycleDeps, Verdict } from "./task-types.js";
import type { ReviewerConfig, RoleConfig } from "../config/config.js";
import type { ProgressEvent } from "./progress.js";

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
}
/** Structured choices for a question → the TUI renders a selectable checkbox/radio list. */
export interface AskOpts { options?: string[]; multiSelect?: boolean }
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
/** The team's medium/low findings, flattened → carried to the next stage instead of forcing another round. */
function nonBlockingNotes(assessments: Assessment[]): string[] {
  return assessments.flatMap((a) => a.findings.filter((f) => f.severity !== "critical").map((f) => `[${f.severity}] ${a.name}: ${f.note}`));
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

/**
 * Runs a STAGE's team in parallel; each lens reviews the target read-only and produces a named assessment.
 * `target` is the doc path (spec/plan) or a description of the code change; `request` is the user's original
 * ask — the scope anchor every lens judges against (without it a lens optimizes toward an idealized system).
 */
export async function runTeam(
  deps: ReviewDeps, stage: ReviewStage, workdir: string, target: string, request?: string,
  emit: (ev: ProgressEvent) => void = () => {},
): Promise<Assessment[]> {
  const team = deps.teams[stage];
  const registry = deps.teamRegistries[stage];
  const scope = request ? `\n\nThe user's original request (the scope you must judge against):\n"""\n${request}\n"""` : "";
  const what = stage === "code" ? `Review the code for: ${target}.` : `Review the "${target}" document.`;
  // Surface each team member as a live sub-agent (they run in parallel) so the user sees the review happening.
  emit({ kind: "agents", agents: team.map((c) => ({ id: `team:${c.name}`, title: `team: ${c.name}`, model: registry.peekModel(c.name) })) });
  try {
    return await Promise.all(
      team.map(async (c): Promise<Assessment> => {
        const resolved = registry.resolve(c.name);
        const tok = { promptTokens: 0, completionTokens: 0 }; // this member's own token spend (like the shimmer)
        const opts: RoleAgentOptions = {
          provider: deps.provider, ...resolved,
          tools: readOnlyRegistry(deps),
          messages: [{ role: "user", content: `${what} Evaluate it through your lens.${scope}` }],
          permission: deps.permission, approve: deps.approve, cwd: workdir, signal: deps.signal,
          onUsage: (u) => { tok.promptTokens += u.promptTokens; tok.completionTokens += u.completionTokens; },
        };
        try {
          const r = await runStructuredRole(opts, AssessmentSchema);
          const a: Assessment = { name: c.name, findings: r.findings, recommendation: r.recommendation };
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
          emit({ kind: "agent-result", id: `team:${c.name}`, status: "⚠ UNVERIFIED (no response)", ...tok });
          return { name: c.name, recommendation: "revise", findings: [{ severity: "critical", note: `The "${c.name}" lens could not complete its review (no response from its model chain) — this dimension is UNVERIFIED and must be re-checked (check the model assigned to it).` }] };
        }
      }),
    );
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
export async function runCouncil(
  deps: ReviewDeps, stage: ReviewStage, workdir: string, target: string, assessments: Assessment[],
  request?: string, emit: (ev: ProgressEvent) => void = () => {},
): Promise<CouncilVote[]> {
  const digest = findingsDigest(assessments);
  const scope = request ? `\n\nThe user's original request:\n"""\n${request}\n"""` : "";
  const subject = stage === "code" ? `the code for: ${target}` : `the "${target}" ${stage}`;
  emit({ kind: "agents", agents: deps.council.map((c) => ({ id: `council:${c.name}`, title: `council: ${c.name}`, model: deps.councilRegistry.peekModel(c.name) })) });
  try {
    const results = await Promise.all(
      deps.council.map(async (c): Promise<CouncilVote> => {
        const resolved = deps.councilRegistry.resolve(c.name);
        const tok = { promptTokens: 0, completionTokens: 0 };
        const opts: RoleAgentOptions = {
          provider: deps.provider, ...resolved,
          tools: readOnlyRegistry(deps),
          messages: [{ role: "user", content: `You are reviewing ${subject} (the ${stage} stage), plus the team's findings:\n${digest}${scope}\n\nCast your vote (pass/revise) with a rationale.` }],
          permission: deps.permission, approve: deps.approve, cwd: workdir, signal: deps.signal,
          onUsage: (u) => { tok.promptTokens += u.promptTokens; tok.completionTokens += u.completionTokens; },
        };
        try {
          const r = await runStructuredRole(opts, CouncilVoteSchema);
          // Stream this vote onto its live row as it lands (no chat note — the tally is one action from the caller).
          emit({ kind: "agent-result", id: `council:${c.name}`, status: r.vote === "pass" ? "PASS" : "REVISE", ...tok });
          return { name: c.name, vote: r.vote, rationale: r.rationale };
        } catch (e) {
          if (deps.signal.aborted) throw e; // genuine cancellation → propagate
          // Fail-SAFE: a decider that can't vote counts as a conservative REVISE (we can't confirm the doc is
          // fine), never silently dropped — otherwise a shrunk council could accidentally reach a "pass".
          emit({ kind: "agent-result", id: `council:${c.name}`, status: "⚠ UNVERIFIED (no response)", ...tok });
          return { name: c.name, vote: "revise", rationale: `The "${c.name}" decider could not vote (no response) — counted as revise to be safe.` };
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
export async function runJudge(
  deps: ReviewDeps, stage: ReviewStage, workdir: string, target: string, assessments: Assessment[], votes: CouncilVote[],
  request?: string, emit: (ev: ProgressEvent) => void = () => {},
): Promise<JudgeDecision> {
  const resolved = deps.roleRegistry.resolve("judge");
  const findings = findingsDigest(assessments);
  const council = votes.map((v) => `- ${v.name}: ${v.vote} — ${v.rationale}`).join("\n");
  const subject = stage === "code" ? `The code for "${target}"` : `The "${target}" ${stage}`;
  const opts: RoleAgentOptions = {
    provider: deps.provider, ...resolved,
    tools: readOnlyRegistry(deps),
    messages: [{ role: "user", content:
      `${subject} is contested (the ${stage} review stage).${request ? `\n\nThe user's original request:\n"""\n${request}\n"""` : ""}\n\n` +
      `The review team's findings:\n${findings}\n\n` +
      `The council voted but reached NO supermajority:\n${council}\n\n` +
      `You are the final decider. Judge it against what was asked for and against what THIS stage is responsible ` +
      `for (a spec answers WHAT/WHY, a plan answers HOW, code is the implementation). Decide (pass/revise/ask-human).` }],
    permission: deps.permission, approve: deps.approve, cwd: workdir, signal: deps.signal,
  };
  let d: JudgeDecision;
  try {
    d = await runStructuredRole(opts, JudgeSchema);
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
  let prevCriticals = Number.POSITIVE_INFINITY; // convergence guard: criticals must DROP round over round
  // Outer loop: run a batch of up to `maxRounds` council/judge rounds; if none pass, escalate to the human,
  // who may approve as-is, ask for MORE review rounds (another batch), or stop. Only "stop" ends without approval.
  for (;;) {
    for (let i = 0; i < maxRounds; i++, round++) {
      // ACTION narrative only: the chat tracks WHO is deciding and the hand-offs (team → council → judge),
      // not what each agent produced. Members' raw findings/votes stay out of the chat flow by design.
      emit({ kind: "note", text: `🔍 **Reviewing the ${label}** (round ${round + 1}) — the team (${deps.teams[stage].length}) is discussing it…` });
      const assessments = await runTeam(deps, stage, workdir, target, request, emit);
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
        // No blocking issue left: pass and DEFER the remaining medium/low findings to the next stage.
        const deferred = nonBlockingNotes(assessments);
        emit({ kind: "note", text: `✅ **Team** — no critical findings left → the ${label} is approved.${deferred.length ? ` ${deferred.length} medium/low note(s) carried forward to the next stage.` : ""}` });
        return { approved: true, deferred };
      }

      // Not converging? If the critical count didn't drop versus the previous round, more rounds won't help —
      // stop burning them and take it to the human now.
      if (round > 0 && crit >= prevCriticals) {
        emit({ kind: "note", text: `⚠️ **Review is not converging** — ${crit} critical finding(s), no better than the previous round. Taking it to you instead of spending more rounds.` });
        prevCriticals = crit;
        break;
      }
      prevCriticals = crit;

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
        emit({ kind: "note", text: `✅ **Council** voted to approve (${passVotes}/${votes.length} pass) → the ${label} is approved.` });
        return { approved: true };
      } else if (tally === "revise") {
        emit({ kind: "note", text: `🔄 **Council** voted to revise (${votes.length - passVotes}/${votes.length}) → sending the ${label} back for changes.` });
        decision = { decision: "revise", feedback: votes.filter((v) => v.vote === "revise").map((v) => v.rationale), question: "" };
      } else {
        // Split vote → the council defers the final call to the judge.
        emit({ kind: "note", text: `🔨 **Council** was split (${passVotes}/${votes.length} pass) → deferred the final decision to the **judge**.` });
        decision = await runJudge(deps, stage, workdir, target, assessments, votes, request, emit);
        if (decision.decision === "pass") { emit({ kind: "note", text: `✅ **Judge** approved the ${label}.` }); return { approved: true }; }
      }

      let feedback = decision.feedback;
      if (decision.decision === "ask-human") {
        emit({ kind: "note", text: `❓ Judge needs your input: ${decision.question}` });
        const answer = await askUser(decision.question);
        feedback = [...feedback, `Human answer: ${answer}`];
      }
      emit({ kind: "note", text: `🔄 Revising the ${label} with the feedback…` });
      await revise(feedback);
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
 * CODE-stage review: runs the code lens team on one task's implementation, then the same
 * team → council → judge escalation as the doc stages — but SINGLE-SHOT (no revise loop here: the task cycle's
 * escalation ladder owns retries). Returns the task-cycle Verdict, with the blocking findings as notes.
 */
export async function runCodeReview(
  deps: ReviewDeps, workdir: string, taskTitle: string, request?: string,
  emit: (ev: ProgressEvent) => void = () => {},
  attempt = 0, // how many times this task has already been reviewed+revised → drives the tiered bar
): Promise<Verdict> {
  emit({ kind: "note", text: `🔍 **Reviewing the code** for "${taskTitle}" — the team (${deps.teams.code.length}) is discussing it…` });
  const assessments = await runTeam(deps, "code", workdir, taskTitle, request, emit);
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
    const deferred = nonBlockingNotes(assessments);
    emit({ kind: "note", text: `✅ **Team** — no critical findings left → the code passed.${deferred.length ? ` ${deferred.length} medium/low note(s) noted but not blocking:\n${deferred.map((d) => `- ${d}`).join("\n")}` : ""}` });
    return { verdict: "pass", notes: [] };
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
