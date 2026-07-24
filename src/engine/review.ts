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

export interface Assessment { name: string; concerns: string[]; recommendation: "approve" | "revise" }
export const AssessmentSchema = z.object({
  concerns: z.array(z.string()),
  recommendation: z.enum(["approve", "revise"]),
});

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
    `Review the given document from this perspective; produce a reasoned concerns list and a recommendation (approve/revise). ` +
    `Write your concerns in ENGLISH — they are a technical review artifact (documentation), not a conversation with the user, ` +
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
      deps.team.map(async (c) => {
        const resolved = deps.teamRegistry.resolve(c.name);
        const opts: RoleAgentOptions = {
          provider: deps.provider, ...resolved,
          tools: readOnlyRegistry(deps),
          messages: [{ role: "user", content: `Review the "${docPath}" document and evaluate it from this perspective.` }],
          permission: deps.permission, approve: deps.approve, cwd: workdir, signal: deps.signal,
        };
        const r = await runStructuredRole(opts, AssessmentSchema);
        // Surface each member's finding live as it lands — the review reads like a real discussion.
        emit({ kind: "note", text: r.recommendation === "approve"
          ? `● \`${c.name}\` reviewed — ✓ no concerns`
          : `● \`${c.name}\` reviewed — ⚠ ${r.concerns.join("; ") || "requests changes"}` });
        return { name: c.name, concerns: r.concerns, recommendation: r.recommendation };
      }),
    );
  } finally {
    emit({ kind: "agents", agents: [] }); // clear the live-agents panel when the team finishes
  }
}

/** A short digest of the team's findings, handed to the council/judge as the evidence to weigh. */
function findingsDigest(assessments: Assessment[]): string {
  return assessments.map((a) => `- ${a.name} (${a.recommendation}): ${a.concerns.join("; ") || "no concerns"}`).join("\n");
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
    return await Promise.all(
      deps.council.map(async (c) => {
        const resolved = deps.councilRegistry.resolve(c.name);
        const opts: RoleAgentOptions = {
          provider: deps.provider, ...resolved,
          tools: readOnlyRegistry(deps),
          messages: [{ role: "user", content: `The "${docPath}" document plus the team's findings:\n${digest}\n\nCast your vote (pass/revise) with a rationale.` }],
          permission: deps.permission, approve: deps.approve, cwd: workdir, signal: deps.signal,
        };
        const r = await runStructuredRole(opts, CouncilVoteSchema);
        emit({ kind: "note", text: `⚖ \`council:${c.name}\` → ${r.vote === "pass" ? "✓ pass" : "⤾ revise"} — ${r.rationale}` });
        return { name: c.name, vote: r.vote, rationale: r.rationale };
      }),
    );
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
  const d = await runStructuredRole(opts, JudgeSchema);
  const j = `⚖️ **Judge** (${resolved.model})`;
  emit({ kind: "note", text: d.decision === "pass" ? `${j} → **pass** — approved`
    : d.decision === "revise" ? `${j} → **revise**: ${d.feedback.join("; ") || "addressing the concerns"}`
    : `${j} → **ask-human** — the council split and the judge needs your input` });
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
      emit({ kind: "note", text: `**Reviewing the ${label}** (round ${round + 1}) — ${deps.team.length}-member team evaluating in parallel…` });
      const assessments = await runTeam(deps, workdir, docPath, emit);
      // Team consensus first: if a strong majority approves, pass — don't convene the council over a nitpick.
      const approve = assessments.filter((a) => a.recommendation === "approve").length;
      if (assessments.length && approve / assessments.length >= TEAM_CONSENSUS) {
        emit({ kind: "note", text: `✅ Team consensus — ${approve}/${assessments.length} approve. The ${label} passed.` });
        return { approved: true };
      }

      // Contested → convene the council: 5 strong members weigh the findings and VOTE.
      emit({ kind: "note", text: `⚖ Team is split (${approve}/${assessments.length} approve) — convening the ${deps.council.length}-member council to vote…` });
      const votes = await runCouncil(deps, workdir, docPath, assessments, emit);
      const tally = tallyCouncil(votes);
      const passVotes = votes.filter((v) => v.vote === "pass").length;

      let decision: JudgeDecision;
      if (tally === "pass") {
        emit({ kind: "note", text: `✅ Council supermajority — ${passVotes}/${votes.length} pass. The ${label} is approved.` });
        return { approved: true };
      } else if (tally === "revise") {
        emit({ kind: "note", text: `⤾ Council supermajority — ${votes.length - passVotes}/${votes.length} revise. Revising the ${label}…` });
        decision = { decision: "revise", feedback: votes.filter((v) => v.vote === "revise").map((v) => v.rationale), question: "" };
      } else {
        // Split vote → the judge is the final link.
        emit({ kind: "note", text: `⚖ Council split (${passVotes}/${votes.length} pass) — escalating to the judge (final decision)…` });
        decision = await runJudge(deps, workdir, docPath, assessments, votes, emit);
        if (decision.decision === "pass") { emit({ kind: "note", text: `✅ The ${label} passed review.` }); return { approved: true }; }
      }

      let feedback = decision.feedback;
      if (decision.decision === "ask-human") {
        emit({ kind: "note", text: `❓ Judge needs your input: ${decision.question}` });
        const answer = await askUser(decision.question);
        feedback = [...feedback, `Human answer: ${answer}`];
      }
      emit({ kind: "note", text: `↻ Revising the ${label} with the feedback…` });
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
    emit({ kind: "note", text: language === "Turkish" ? "↻ Anlaşılamadı — review'a devam ediliyor." : "↻ Unclear answer — continuing the review." });
  }
}
