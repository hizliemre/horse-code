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
    `Review the given document from this perspective; produce a reasoned concerns list and a recommendation (approve/revise).`
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
        return { name: c.name, concerns: r.concerns, recommendation: r.recommendation };
      }),
    );
  } finally {
    emit({ kind: "agents", agents: [] }); // clear the live-agents panel when the council finishes
  }
}

/** Judge synthesizes the council's evaluations into a single decision (pass/revise/ask-human). */
export async function runJudge(
  deps: ReviewDeps, workdir: string, docPath: string, assessments: Assessment[],
): Promise<JudgeDecision> {
  const resolved = deps.roleRegistry.resolve("judge");
  const summary = assessments.map((a) => `- ${a.name} (${a.recommendation}): ${a.concerns.join("; ")}`).join("\n");
  const opts: RoleAgentOptions = {
    provider: deps.provider, ...resolved,
    tools: readOnlyRegistry(deps),
    messages: [{ role: "user", content: `The "${docPath}" document and council evaluations:\n${summary}\nSynthesize and decide.` }],
    permission: deps.permission, approve: deps.approve, cwd: workdir, signal: deps.signal,
  };
  return runStructuredRole(opts, JudgeSchema);
}

/**
 * §6 review loop: council → judge; pass→approved, revise→revise(feedback)→retry,
 * ask-human→askUser→feedback→revise→retry. Once maxRounds is exhausted, a final human decision (approve/stop).
 */
export async function runReviewLoop(
  deps: ReviewDeps,
  workdir: string,
  docPath: string,
  revise: (feedback: string[]) => Promise<void>,
  askUser: AskUser,
  maxRounds: number,
  emit: (ev: ProgressEvent) => void = () => {},
): Promise<ReviewOutcome> {
  for (let round = 0; round < maxRounds; round++) {
    const assessments = await runCouncil(deps, workdir, docPath, emit);
    const d = await runJudge(deps, workdir, docPath, assessments);
    if (d.decision === "pass") return { approved: true };
    let feedback = d.feedback;
    if (d.decision === "ask-human") {
      const answer = await askUser(d.question);
      feedback = [...feedback, `Human answer: ${answer}`];
    }
    await revise(feedback);
  }
  const answer = await askUser(`Not approved after ${maxRounds} revision rounds. Approve / stop?`);
  // Word-boundary exact match: don't count negations like "I don't approve" as approval by substring.
  return { approved: /^\s*(approve|yes)\s*$/i.test(answer) };
}
