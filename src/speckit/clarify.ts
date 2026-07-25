import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import { runToCompletion } from "../agent/loop.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { writerRegistry } from "../engine/writer-registry.js";
import type { PhaseDeps } from "./phases.js";
import type { FeaturePaths } from "./layout.js";

export const ClarifyStepSchema = z.object({
  // The single most important clarifying question, or null when the spec is sufficiently clear.
  nextQuestion: z.string().nullable(),
});

/**
 * Structured clarify loop: each round the role reads the spec and returns ONE question (or null to finish).
 * The user's answer is fed back; the role updates the spec before the next round. Capped at `maxRounds`.
 */
export async function runClarify(p: PhaseDeps, paths: FeaturePaths, maxRounds = 5): Promise<void> {
  const specRel = relative(p.workdir, paths.spec);
  const specText = (): string => (existsSync(paths.spec) ? readFileSync(paths.spec, "utf8") : "");
  const before = specText();
  // fallbackOpts: clarify is driven by the spec-kit clarify command prompt (own prompt), but wants the
  // analyst's model chain + session-fallback on exhaustion.
  const { model, fallbacks, onExhausted, onFallback } = p.deps.roleRegistry.fallbackOpts("analyst");
  const qa: string[] = [];
  for (let round = 0; round < maxRounds; round++) {
    const context = qa.length ? `\n\nAnswers so far:\n${qa.join("\n")}` : "";
    const opts: RoleAgentOptions = {
      provider: p.deps.provider,
      model,
      fallbacks,
      onExhausted,
      onFallback,
      systemPrompt: `${p.templates.command("clarify")}\n\nAsk at most one question per turn.${p.deps.roleRegistry.ruleSuffix()}`,
      tools: writerRegistry(p.deps.skillRegistry),
      messages: [{
        role: "user",
        content:
          `Read the spec "${specRel}". Identify the single most important underspecified point and return it as ` +
          `nextQuestion, or null if the spec is clear enough. If you already have an answer below, first update ` +
          `the spec at "${specRel}" (write_file/edit_file) to incorporate it, then decide the next question.${context}`,
      }],
      permission: p.deps.permission,
      approve: p.deps.approve,
      cwd: p.workdir,
      signal: p.deps.signal,
      onActivity: p.deps.onActivity,
    };
    const step = await runStructuredRole(opts, ClarifyStepSchema);
    if (!step.nextQuestion) break;
    const answer = await p.askUser(step.nextQuestion);
    qa.push(`Q: ${step.nextQuestion}\nA: ${answer}`);
  }

  // The user answered questions but the spec never changed → those answers were about to be LOST (the plan
  // stage would read a spec that never absorbed them). Do one explicit write-back pass before giving up.
  if (qa.length > 0 && specText() === before) {
    const opts: RoleAgentOptions = {
      provider: p.deps.provider,
      model, fallbacks, onExhausted, onFallback,
      systemPrompt: `${p.templates.command("clarify")}${p.deps.roleRegistry.ruleSuffix()}`,
      tools: writerRegistry(p.deps.skillRegistry),
      messages: [{
        role: "user",
        content:
          `The clarification answers below were NOT written into the spec. Update "${specRel}" now with ` +
          `write_file/edit_file so every answer is reflected in the requirements — this is the only step that ` +
          `persists them.\n\n${qa.join("\n\n")}`,
      }],
      permission: p.deps.permission,
      approve: p.deps.approve,
      cwd: p.workdir,
      signal: p.deps.signal,
      onActivity: p.deps.onActivity,
    };
    await runToCompletion(opts);
  }
}
