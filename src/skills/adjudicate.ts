import type { ChatRequest, Provider } from "../core/types.js";
import { partitionByConfidence } from "./route.js";
import type { SkillMatch } from "./route.js";
import type { SkillRegistry } from "./registry.js";

/**
 * A second opinion on the routing matches that word-overlap cannot decide.
 *
 * Deterministic matching answers "does this task use this skill's vocabulary?" — which is not the question.
 * The question is "is this task the kind of work this skill is for", and on a real Angular project the two
 * came apart exactly where you would expect: `implement store crud methods` and `configure ngrx signal store`
 * both matched a design skill on architecture words while being nothing to do with interface design.
 *
 * So a model is asked, but ONLY about the matches sitting at the bar. Matches well clear of it were right
 * without help, and paying for a judgement on them would be paying for an answer already known.
 *
 * Measured on 23 real tasks from an Angular project: 8 matched nothing and cost nothing, 15 were borderline
 * and were adjudicated, and 14 of those 15 changed — almost all of them to "no skill applies". So this is not
 * a rare tie-break bolted onto a mostly-free path; on a real codebase most matches ARE borderline, and this
 * is where the routing decision actually gets made. The call is small (a few hundred tokens against a task
 * that will spend tens of thousands), which is what makes paying it on most tasks the right trade.
 *
 * A failure here keeps the deterministic answer rather than dropping the skills: the fallback is the
 * behaviour that shipped before, not silence.
 */
export async function adjudicateSkills(opts: {
  provider: Provider;
  model: string;
  task: string;
  matches: SkillMatch[];
  registry: SkillRegistry;
  signal?: AbortSignal;
  bar?: number;
  margin?: number;
}): Promise<{ keep: SkillMatch[]; asked: boolean; reasoning?: string }> {
  const { confident, borderline } = partitionByConfidence(opts.matches, opts.bar, opts.margin);
  if (!borderline.length) return { keep: confident, asked: false };

  const described = borderline
    .map((m) => `- ${m.name}: ${opts.registry.get(m.name)?.description ?? "(no description)"}`)
    .join("\n");
  const systemPrompt =
    `Decide which of these skills, if any, genuinely apply to one development task.\n\n` +
    `A skill is a document inlined into the agent's instructions: whatever it says, the agent will do. So a ` +
    `skill on the wrong task is worse than no skill — the agent will follow it.\n\n` +
    `Judge by whether the task IS the kind of work the skill is for, not by whether they share words. ` +
    `"Implement store CRUD methods" mentions components and state, but it is data-layer work, not interface ` +
    `design. Rejecting all of them is a normal and frequent answer.\n\n` +
    `Task: ${opts.task}\n\nCandidates:\n${described}\n\n` +
    `Answer with a fenced \`\`\`json block: {"keep":["<skill name>", …]} — an empty list if none apply. ` +
    `One short sentence of reasoning before it.`;

  try {
    const req: ChatRequest = {
      model: opts.model,
      messages: [
        { role: "system", content: "You decide whether a skill applies to a task. You reject far more often than you accept." },
        { role: "user", content: systemPrompt },
      ],
      tools: [],
    };
    let full = "";
    for await (const ev of opts.provider.chat(req, opts.signal ?? new AbortController().signal)) {
      if (ev.type === "text-delta") full += ev.text;
      else if (ev.type === "error") throw new Error(ev.message);
    }
    const keep = parseKeep(full);
    if (!keep) throw new Error("unparseable verdict");
    const kept = borderline.filter((m) => keep.includes(m.name));
    return {
      keep: [...confident, ...kept],
      asked: true,
      reasoning: full.split("```")[0].replace(/<\/?think>/gi, "").trim().slice(0, 200),
    };
  } catch {
    // Keeping the deterministic answer is the safe failure: it is what shipped before adjudication existed.
    return { keep: opts.matches, asked: false };
  }
}

function parseKeep(text: string): string[] | undefined {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fence ? fence[1] : text.slice(text.indexOf("{"));
  try {
    const parsed = JSON.parse(raw) as { keep?: unknown };
    return Array.isArray(parsed.keep) ? parsed.keep.filter((k): k is string => typeof k === "string") : undefined;
  } catch {
    return undefined;
  }
}
