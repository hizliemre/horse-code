import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { RoleRegistry } from "../agent/roles.js";
import { readOnlyRegistry } from "./reviewer.js";
import type { TaskCycleDeps } from "./task-types.js";
import type { CouncilorConfig, RoleConfig } from "../config/config.js";

export interface ReviewDeps extends TaskCycleDeps {
  councilRegistry: RoleRegistry;
  councilors: CouncilorConfig[];
}
export type AskUser = (question: string) => Promise<string>;

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
    `Sen bir review council üyesisin. Perspektifin: ${perspective}. ` +
    `Verilen dokümanı bu perspektiften incele; gerekçeli concerns listesi ve öneri (approve/revise) üret.`
  );
}

/** Councilor'ları round-robin bir RoleRegistry'ye çevirir (name → perspektif prompt'lu role). */
export function buildCouncilRegistry(councilors: CouncilorConfig[]): RoleRegistry {
  const roles: Record<string, RoleConfig> = {};
  for (const c of councilors) roles[c.name] = { models: c.models, systemPrompt: councilPrompt(c.perspective) };
  return new RoleRegistry(roles);
}

/** Councilor'ları paralel koşar; her biri dokümanı salt-okunur inceleyip isimli assessment üretir. */
export async function runCouncil(deps: ReviewDeps, workdir: string, docPath: string): Promise<Assessment[]> {
  return Promise.all(
    deps.councilors.map(async (c) => {
      const { model, systemPrompt } = deps.councilRegistry.resolve(c.name);
      const opts: RoleAgentOptions = {
        provider: deps.provider, model, systemPrompt,
        tools: readOnlyRegistry(deps),
        messages: [{ role: "user", content: `"${docPath}" dokümanını incele ve bu perspektiften değerlendir.` }],
        permission: deps.permission, approve: deps.approve, cwd: workdir, signal: deps.signal,
      };
      const r = await runStructuredRole(opts, AssessmentSchema);
      return { name: c.name, concerns: r.concerns, recommendation: r.recommendation };
    }),
  );
}

/** Judge council değerlendirmelerini sentezleyip tek karar verir (pass/revize/ask-human). */
export async function runJudge(
  deps: ReviewDeps, workdir: string, docPath: string, assessments: Assessment[],
): Promise<JudgeDecision> {
  const { model, systemPrompt } = deps.roleRegistry.resolve("judge");
  const summary = assessments.map((a) => `- ${a.name} (${a.recommendation}): ${a.concerns.join("; ")}`).join("\n");
  const opts: RoleAgentOptions = {
    provider: deps.provider, model, systemPrompt,
    tools: readOnlyRegistry(deps),
    messages: [{ role: "user", content: `"${docPath}" dokümanı ve council değerlendirmeleri:\n${summary}\nSentezle ve karar ver.` }],
    permission: deps.permission, approve: deps.approve, cwd: workdir, signal: deps.signal,
  };
  return runStructuredRole(opts, JudgeSchema);
}

/**
 * §6 review döngüsü: council → judge; pass→onaylı, revize→revise(feedback)→tekrar,
 * ask-human→askUser→feedback→revise→tekrar. maxRounds tükenince son insan kararı (onayla/durdur).
 */
export async function runReviewLoop(
  deps: ReviewDeps,
  workdir: string,
  docPath: string,
  revise: (feedback: string[]) => Promise<void>,
  askUser: AskUser,
  maxRounds: number,
): Promise<ReviewOutcome> {
  for (let round = 0; round < maxRounds; round++) {
    const assessments = await runCouncil(deps, workdir, docPath);
    const d = await runJudge(deps, workdir, docPath, assessments);
    if (d.decision === "pass") return { approved: true };
    let feedback = d.feedback;
    if (d.decision === "ask-human") {
      const answer = await askUser(d.question);
      feedback = [...feedback, `İnsan cevabı: ${answer}`];
    }
    await revise(feedback);
  }
  const answer = await askUser(`${maxRounds} revize turunda onaylanmadı. Onayla / durdur?`);
  return { approved: /onayla|approve|evet|yes/i.test(answer) };
}
