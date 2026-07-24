import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { RoleRegistry } from "../agent/roles.js";
import { readOnlyRegistry } from "./reviewer.js";
import type { TaskCycleDeps } from "./task-types.js";
import type { ReviewerConfig, RoleConfig } from "../config/config.js";
import type { ProgressEvent } from "./progress.js";

export interface ReviewDeps extends TaskCycleDeps {
  // Two-stage review: the TEAM (many single-angle lenses) produces findings; the COUNCIL (a small strong panel)
  // votes on a contested doc. Each has its own round-robin registry of named reviewer roles.
  teamRegistry: RoleRegistry;
  team: ReviewerConfig[];
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

export interface ReviewOutcome { approved: boolean }

function teamPrompt(perspective: string): string {
  return (
    `You are a review TEAM member. Your perspective: ${perspective}. ` +
    `Review the given document from this perspective and produce a list of findings — each with a SEVERITY ` +
    `("critical" = blocks shipping, "medium" = should fix, "low" = minor/nit) and a concise note — plus a ` +
    `recommendation: "approve" (no blocking issues) or "revise" (needs changes). Report only genuine issues; an ` +
    `empty findings list with "approve" is the right answer for a clean document. ` +
    `Write findings in ENGLISH — they are a technical review artifact, not a conversation with the user, ` +
    `so they stay English regardless of any conversational-language rule.`
  );
}

function councilPrompt(perspective: string): string {
  return (
    `You are a member of the review COUNCIL — a small, senior decision panel. Your judgment lens: ${perspective}. ` +
    `You are given the document AND the review team's findings. Weigh them and cast a single vote: "pass" (ship the ` +
    `document as-is) or "revise" (it needs changes first), with a concise rationale. Do not nitpick — vote "revise" ` +
    `only for issues that genuinely warrant another pass. Write the rationale in ENGLISH regardless of any ` +
    `conversational-language rule (it is a technical review artifact).`
  );
}

/** Converts reviewer configs into a round-robin RoleRegistry (name → role with the given prompt builder). */
function buildReviewerRegistry(reviewers: ReviewerConfig[], prompt: (p: string) => string): RoleRegistry {
  const roles: Record<string, RoleConfig> = {};
  for (const r of reviewers) roles[r.name] = { models: r.models, systemPrompt: prompt(r.perspective) };
  return new RoleRegistry(roles);
}

/** The 15-lens finder team → each produces concerns + an approve/revise recommendation. */
export function buildTeamRegistry(team: ReviewerConfig[]): RoleRegistry {
  return buildReviewerRegistry(team, teamPrompt);
}
/** The small decider council → each casts a pass/revise vote with a rationale. */
export function buildCouncilRegistry(council: ReviewerConfig[]): RoleRegistry {
  return buildReviewerRegistry(council, councilPrompt);
}

/** Runs the team in parallel; each lens reviews the document read-only and produces a named assessment. */
export async function runTeam(
  deps: ReviewDeps, workdir: string, docPath: string, emit: (ev: ProgressEvent) => void = () => {},
): Promise<Assessment[]> {
  // Surface each team member as a live sub-agent (they run in parallel) so the user sees the review happening.
  emit({ kind: "agents", agents: deps.team.map((c) => ({ id: `team:${c.name}`, title: `team: ${c.name}`, model: deps.teamRegistry.peekModel(c.name) })) });
  try {
    return await Promise.all(
      deps.team.map(async (c): Promise<Assessment> => {
        const resolved = deps.teamRegistry.resolve(c.name);
        const tok = { promptTokens: 0, completionTokens: 0 }; // this member's own token spend (like the shimmer)
        const opts: RoleAgentOptions = {
          provider: deps.provider, ...resolved,
          tools: readOnlyRegistry(deps),
          messages: [{ role: "user", content: `Review the "${docPath}" document and evaluate it from this perspective.` }],
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
  deps: ReviewDeps, workdir: string, docPath: string, assessments: Assessment[], emit: (ev: ProgressEvent) => void = () => {},
): Promise<CouncilVote[]> {
  const digest = findingsDigest(assessments);
  emit({ kind: "agents", agents: deps.council.map((c) => ({ id: `council:${c.name}`, title: `council: ${c.name}`, model: deps.councilRegistry.peekModel(c.name) })) });
  try {
    const results = await Promise.all(
      deps.council.map(async (c): Promise<CouncilVote> => {
        const resolved = deps.councilRegistry.resolve(c.name);
        const tok = { promptTokens: 0, completionTokens: 0 };
        const opts: RoleAgentOptions = {
          provider: deps.provider, ...resolved,
          tools: readOnlyRegistry(deps),
          messages: [{ role: "user", content: `The "${docPath}" document plus the team's findings:\n${digest}\n\nCast your vote (pass/revise) with a rationale.` }],
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
  deps: ReviewDeps, workdir: string, docPath: string, assessments: Assessment[], votes: CouncilVote[], emit: (ev: ProgressEvent) => void = () => {},
): Promise<JudgeDecision> {
  const resolved = deps.roleRegistry.resolve("judge");
  const findings = findingsDigest(assessments);
  const council = votes.map((v) => `- ${v.name}: ${v.vote} — ${v.rationale}`).join("\n");
  const opts: RoleAgentOptions = {
    provider: deps.provider, ...resolved,
    tools: readOnlyRegistry(deps),
    messages: [{ role: "user", content:
      `The "${docPath}" document is contested. The review team's findings:\n${findings}\n\n` +
      `The council voted but reached NO supermajority:\n${council}\n\nYou are the final decider. Synthesize and decide (pass/revise/ask-human).` }],
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

export async function runReviewLoop(
  deps: ReviewDeps,
  workdir: string,
  docPath: string,
  revise: (feedback: string[]) => Promise<void>,
  askUser: AskUser,
  maxRounds: number,
  emit: (ev: ProgressEvent) => void = () => {},
  language?: string, // the user's language (from the refiner) → localize the human-facing escalation prompt
): Promise<ReviewOutcome> {
  const label = /plan/i.test(docPath) ? "plan" : "spec";
  let round = 0;
  // Outer loop: run a batch of up to `maxRounds` council/judge rounds; if none pass, escalate to the human,
  // who may approve as-is, ask for MORE review rounds (another batch), or stop. Only "stop" ends without approval.
  for (;;) {
    for (let i = 0; i < maxRounds; i++, round++) {
      // ACTION narrative only: the chat tracks WHO is deciding and the hand-offs (team → council → judge),
      // not what each agent produced. Members' raw findings/votes stay out of the chat flow by design.
      emit({ kind: "note", text: `🔍 **Reviewing the ${label}** (round ${round + 1}) — the team (${deps.team.length}) is discussing it…` });
      const assessments = await runTeam(deps, workdir, docPath, emit);
      // The whole team has reported → write the consolidated result to chat (per-member verdict + counts).
      if (assessments.length) emit({ kind: "note", text: teamSummaryNote(assessments, label) });
      // Team shortcut-pass — but ONLY when the doc is genuinely CLEAN. Each lens is the SOLE authority on its
      // dimension, so a majority "approve" must NOT wave through a serious finding from one lens (e.g. a single
      // critical security finding while the other 14 lenses, which don't inspect security, approve). Shortcut is
      // allowed only when there is NO critical AND NO medium finding anywhere AND a strong majority approves;
      // any critical/medium finding sends it to the council to adjudicate (never auto-passed by count).
      const approve = assessments.filter((a) => a.recommendation === "approve").length;
      const worst = worstSeverity(assessments);
      const clean = worst === "none" || worst === "low"; // no critical/medium → safe to shortcut
      if (assessments.length && clean && approve / assessments.length >= TEAM_CONSENSUS) {
        emit({ kind: "note", text: `✅ **Team** — clean (no critical/medium findings), ${approve}/${assessments.length} approve → the ${label} is approved.` });
        return { approved: true };
      }

      // Contested → the team hands the decision to the council, which weighs the findings and VOTES. Say WHY:
      // a serious finding surfaced, or the team just split on approval.
      const crit = severityTotal(assessments, "critical");
      const med = severityTotal(assessments, "medium");
      const reason = crit || med
        ? `surfaced ${crit} critical / ${med} medium finding(s)`
        : `is split (${approve}/${assessments.length} approve)`;
      emit({ kind: "note", text: `👥 **Team** ${reason} → handed the decision to the **council** (${deps.council.length} members vote).` });
      const votes = await runCouncil(deps, workdir, docPath, assessments, emit);
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
        decision = await runJudge(deps, workdir, docPath, assessments, votes, emit);
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
