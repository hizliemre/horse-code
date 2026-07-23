import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { RoleRegistry } from "../agent/roles.js";
import { readOnlyRegistry } from "./reviewer.js";
import type { TaskCycleDeps } from "./task-types.js";
import type { CouncilorConfig, RoleConfig } from "../config/config.js";
import type { ProgressEvent } from "./progress.js";

export interface ReviewDeps extends TaskCycleDeps {
  councilRegistry: RoleRegistry;
  councilors: CouncilorConfig[];
}
/** Structured choices for a question → the TUI renders a selectable checkbox/radio list. */
export interface AskOpts { options?: string[]; multiSelect?: boolean }
export type AskUser = (question: string, opts?: AskOpts) => Promise<string>;

export interface Assessment { name: string; concerns: string[]; recommendation: "approve" | "revise" }
export const AssessmentSchema = z.object({
  concerns: z.array(z.string()),
  recommendation: z.enum(["approve", "revise"]),
});

export interface JudgeDecision { decision: "pass" | "revise" | "ask-human"; feedback: string[]; question: string }
export const JudgeSchema = z.object({
  decision: z.enum(["pass", "revise", "ask-human"]),
  feedback: z.array(z.string()),
  question: z.string(),
});

export interface ReviewOutcome { approved: boolean }

function councilPrompt(perspective: string): string {
  return (
    `You are a review council member. Your perspective: ${perspective}. ` +
    `Review the given document from this perspective; produce a reasoned concerns list and a recommendation (approve/revise). ` +
    `Write your concerns in ENGLISH — they are a technical review artifact (documentation), not a conversation with the user, ` +
    `so they stay English regardless of any conversational-language rule.`
  );
}

/** Converts councilors into a round-robin RoleRegistry (name → role with a perspective prompt). */
export function buildCouncilRegistry(councilors: CouncilorConfig[]): RoleRegistry {
  const roles: Record<string, RoleConfig> = {};
  for (const c of councilors) roles[c.name] = { models: c.models, systemPrompt: councilPrompt(c.perspective) };
  return new RoleRegistry(roles);
}

/** Runs the councilors in parallel; each one reviews the document read-only and produces a named assessment. */
export async function runCouncil(
  deps: ReviewDeps, workdir: string, docPath: string, emit: (ev: ProgressEvent) => void = () => {},
): Promise<Assessment[]> {
  // Surface each councilor as a live sub-agent (they run in parallel) so the user sees the review happening.
  emit({ kind: "agents", agents: deps.councilors.map((c) => ({ id: `council:${c.name}`, title: `council: ${c.name}`, model: deps.councilRegistry.peekModel(c.name) })) });
  try {
    return await Promise.all(
      deps.councilors.map(async (c) => {
        const resolved = deps.councilRegistry.resolve(c.name);
        const opts: RoleAgentOptions = {
          provider: deps.provider, ...resolved,
          tools: readOnlyRegistry(deps),
          messages: [{ role: "user", content: `Review the "${docPath}" document and evaluate it from this perspective.` }],
          permission: deps.permission, approve: deps.approve, cwd: workdir, signal: deps.signal,
        };
        const r = await runStructuredRole(opts, AssessmentSchema);
        // Surface each councilor's finding live as it lands — the review reads like a real discussion.
        emit({ kind: "note", text: r.recommendation === "approve"
          ? `● \`${c.name}\` reviewed — ✓ no concerns`
          : `● \`${c.name}\` reviewed — ⚠ ${r.concerns.join("; ") || "requests changes"}` });
        return { name: c.name, concerns: r.concerns, recommendation: r.recommendation };
      }),
    );
  } finally {
    emit({ kind: "agents", agents: [] }); // clear the live-agents panel when the council finishes
  }
}

/** Judge synthesizes the council's evaluations into a single decision (pass/revise/ask-human). */
export async function runJudge(
  deps: ReviewDeps, workdir: string, docPath: string, assessments: Assessment[], emit: (ev: ProgressEvent) => void = () => {},
): Promise<JudgeDecision> {
  const resolved = deps.roleRegistry.resolve("judge");
  const summary = assessments.map((a) => `- ${a.name} (${a.recommendation}): ${a.concerns.join("; ")}`).join("\n");
  const opts: RoleAgentOptions = {
    provider: deps.provider, ...resolved,
    tools: readOnlyRegistry(deps),
    messages: [{ role: "user", content: `The "${docPath}" document and council evaluations:\n${summary}\nSynthesize and decide.` }],
    permission: deps.permission, approve: deps.approve, cwd: workdir, signal: deps.signal,
  };
  const d = await runStructuredRole(opts, JudgeSchema);
  const j = `⚖️ **Judge** (${resolved.model})`;
  emit({ kind: "note", text: d.decision === "pass" ? `${j} → **pass** — approved`
    : d.decision === "revise" ? `${j} → **revise**: ${d.feedback.join("; ") || "addressing council concerns"}`
    : `${j} → **ask-human** — the council couldn't settle it` });
  return d;
}

/**
 * §6 review loop: council → judge; pass→approved, revise→revise(feedback)→retry,
 * ask-human→askUser→feedback→revise→retry. Once maxRounds is exhausted, a final human decision (approve/stop).
 */
/** A strong council majority (this share of "approve") passes without troubling the judge — one reviewer's
 *  nitpick shouldn't block an otherwise-approved doc, which matters a lot with a large (15-lens) council. */
const CONSENSUS_THRESHOLD = 0.7;

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
  for (let round = 0; round < maxRounds; round++) {
    emit({ kind: "note", text: `**Reviewing the ${label}** (round ${round + 1}) — ${deps.councilors.length} council members evaluating in parallel…` });
    const assessments = await runCouncil(deps, workdir, docPath, emit);
    // Consensus vote first: if a strong majority approves, pass — don't let a minority's nitpicks force a revise.
    const approve = assessments.filter((a) => a.recommendation === "approve").length;
    if (assessments.length && approve / assessments.length >= CONSENSUS_THRESHOLD) {
      emit({ kind: "note", text: `✅ Council consensus — ${approve}/${assessments.length} approve. The ${label} passed.` });
      return { approved: true };
    }
    // Contested → the judge synthesizes the decision.
    const d = await runJudge(deps, workdir, docPath, assessments, emit);
    if (d.decision === "pass") { emit({ kind: "note", text: `✅ The ${label} passed review.` }); return { approved: true }; }
    let feedback = d.feedback;
    if (d.decision === "ask-human") {
      emit({ kind: "note", text: `❓ Judge needs your input: ${d.question}` });
      const answer = await askUser(d.question);
      feedback = [...feedback, `Human answer: ${answer}`];
    }
    emit({ kind: "note", text: `↻ Revising the ${label} with the feedback…` });
    await revise(feedback);
  }
  // Escalation to the human — localized to the user's language (this string is code-generated, not from an LLM,
  // so the "respond in <language>" rule wouldn't reach it). Presented as a SELECTABLE choice so a free-text
  // answer like "devam" (continue) can't be misread as a rejection.
  const [q, approveLabel, stopLabel] = language === "Turkish"
    ? [`${maxRounds} revizyon turunda onaylanmadı. Ne yapmak istersin?`, "Devam et (mevcut haliyle onayla)", "Durdur"]
    : [`Not approved after ${maxRounds} revision rounds. What now?`, "Approve (proceed as-is)", "Stop"];
  const answer = await askUser(q, { options: [approveLabel, stopLabel] });
  // Accept the approve option exactly, or a free-typed approval in EN/TR ("continue"/"devam" mean proceed).
  return { approved: answer.trim() === approveLabel || /^\s*(approve|yes|continue|onayla|onay|evet|devam(\s*et)?)\s*$/i.test(answer.trim()) };
}
