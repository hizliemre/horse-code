import type { ChatRequest, Provider } from "../core/types.js";
import { factHolds } from "./project-scan.js";
import type { ProjectProfile } from "./project-scan.js";

export interface SkillInfo {
  name: string;
  description: string;
}

export interface TunedSkills {
  /** role → the skills it should carry. A role present with an empty list is an explicit "none". */
  assignments: Record<string, string[]>;
  reasoning: string;
  /** Assignments the preconditions removed, so the user sees what was withheld and why. */
  withheld: { role: string; skill: string; because: string }[];
}

/**
 * Preconditions for the skills WE ship.
 *
 * The user's complaint is agents acting on their own initiative — a coding agent writing a test suite for a
 * project that does not test. Telling a model "only assign TDD if the project has tests" is advice it can
 * ignore; this table is a gate it cannot. It covers only what we ship and therefore understand. A skill the
 * user added is judged by the model, which is given the same project facts to judge with — we do not pretend
 * to know the preconditions of a skill we have never seen.
 */
export const SKILL_PRECONDITION: Record<string, { fact: string; because: string }> = {
  "test-driven-development": {
    fact: "tests",
    because: "the project has no tests — a coding agent given TDD would build a test suite nobody asked for",
  },
  "frontend-design": {
    fact: "ui",
    because: "the project has no UI",
  },
};

/** Roles that must never carry a skill, whatever a model decides. */
const NEVER: RegExp = /^(coach|judge|council-|team-)/;

function parseAssignments(text: string): Record<string, string[]> {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fence ? fence[1] : text.slice(text.indexOf("{"));
  try {
    const parsed: unknown = JSON.parse(raw);
    const list = (parsed as { assignments?: unknown }).assignments;
    if (!Array.isArray(list)) return {};
    const out: Record<string, string[]> = {};
    for (const item of list) {
      const role = (item as { role?: unknown }).role;
      const skills = (item as { skills?: unknown }).skills;
      if (typeof role !== "string" || !Array.isArray(skills)) continue;
      out[role] = skills.filter((s): s is string => typeof s === "string");
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Drops anything the model should not have assigned: unknown skills, unknown roles, roles that never take one,
 * and — the point of the exercise — skills whose precondition the project fails.
 */
export function applyPreconditions(
  proposed: Record<string, string[]>,
  roles: string[],
  available: string[],
  profile: ProjectProfile,
): { assignments: Record<string, string[]>; withheld: TunedSkills["withheld"] } {
  const withheld: TunedSkills["withheld"] = [];
  const assignments: Record<string, string[]> = {};
  for (const role of roles) {
    if (NEVER.test(role)) continue;
    const wanted = proposed[role] ?? [];
    const kept: string[] = [];
    for (const skill of wanted) {
      if (!available.includes(skill)) continue; // hallucinated or uninstalled → silently not a thing
      const pre = SKILL_PRECONDITION[skill];
      if (pre && !factHolds(profile, pre.fact)) {
        withheld.push({ role, skill, because: pre.because });
        continue;
      }
      if (!kept.includes(skill)) kept.push(skill);
    }
    assignments[role] = kept; // written even when empty: that is the explicit opt-out
  }
  return { assignments, withheld };
}

/**
 * Assigns the installed skills to the roles they fit, for THIS project.
 *
 * Separate from model tuning because it answers a different question and must survive that one failing: a
 * model catalogue problem should not leave every role without its skills.
 */
export async function tuneRoleSkills(opts: {
  provider: Provider;
  tuner: string;
  skills: SkillInfo[];
  roles: string[];
  roleProfiles: Record<string, string>;
  project: ProjectProfile;
  signal?: AbortSignal;
  onReason?: (delta: string) => void;
}): Promise<TunedSkills> {
  const { provider, tuner, skills, roles, project } = opts;
  const assignable = roles.filter((r) => !NEVER.test(r));
  if (!skills.length || !assignable.length) {
    return { assignments: {}, reasoning: "No skills installed.", withheld: [] };
  }

  const skillList = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  const roleList = assignable.map((r) => `- ${r}: ${opts.roleProfiles[r] ?? "(a review role — critiques from a specific angle)"}`).join("\n");
  const systemPrompt =
    `You assign SKILLS to the agent roles of a coding assistant. A skill is a document inlined into a role's ` +
    `system prompt: whatever it says, that agent will do.\n\n` +
    `THIS project — established by scanning the repository, not by guessing:\n${project.summary}\n\n` +
    `Rules:\n` +
    `1. Assign a skill ONLY where it fits the role's actual job. A skill on the wrong role is worse than no ` +
    `skill: the agent will follow it.\n` +
    `2. Assign a skill ONLY if this project's facts above support it. A project with no tests must not get a ` +
    `testing skill — its agents would build a test suite nobody asked for. A project with no UI must not get ` +
    `a design skill.\n` +
    `3. Most roles need NO skill. An empty list is the right answer far more often than not, and a role that ` +
    `already gets its discipline from elsewhere does not need a second one.\n` +
    `4. At most 2 skills per role. Each one is inlined in full into every prompt that role makes.\n` +
    `5. Use ONLY the exact skill names listed — never invent one.\n` +
    `6. A large skill that says when it applies is better left UNASSIGNED: every agent can already discover ` +
    `and fetch it on demand. Assign only what a role should carry every single time.\n\n` +
    `Skills available:\n${skillList}\n\n` +
    `Roles:\n${roleList}\n\n` +
    `First explain your key choices in a few short sentences, including which skills you are deliberately ` +
    `leaving unassigned and why. THEN, on a new line, output ONLY a fenced \`\`\`json block: ` +
    `{"assignments":[{"role":"<role>","skills":["<skill>", …]}, …]} listing ONLY the roles that get at least one.`;

  try {
    const req: ChatRequest = {
      model: tuner,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "Assign the skills. Reason briefly, then give the JSON." },
      ],
      tools: [],
    };
    const stripThink = (s: string): string => s.replace(/<\/?think>/gi, "");
    let full = "";
    let cut = -1;
    for await (const ev of provider.chat(req, opts.signal ?? new AbortController().signal)) {
      if (ev.type === "text-delta") {
        const start = full.length;
        full += ev.text;
        if (cut < 0) {
          const j = full.search(/```|\n\s*\{/);
          if (j >= 0) { if (j > start) opts.onReason?.(stripThink(full.slice(start, j))); cut = j; }
          else opts.onReason?.(stripThink(ev.text));
        }
      } else if (ev.type === "error") {
        throw new Error(ev.message);
      }
    }
    const { assignments, withheld } = applyPreconditions(
      parseAssignments(full), assignable, skills.map((s) => s.name), project,
    );
    return { assignments, reasoning: stripThink(cut >= 0 ? full.slice(0, cut) : full).trim() || "(no rationale given)", withheld };
  } catch (e) {
    // Leaving the existing assignment alone is the safe failure: it is what the user already had.
    return {
      assignments: {},
      reasoning: `Skill assignment failed (${e instanceof Error ? e.message : String(e)}) — skills left as they were.`,
      withheld: [],
    };
  }
}
