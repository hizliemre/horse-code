import type { SkillRegistry } from "./registry.js";

/**
 * Picks the discoverable skills that a specific task actually needs.
 *
 * A discoverable skill is listed for an agent, which then has to notice it and fetch it. That works when the
 * agent is paying attention and silently fails when it is not — the skill is installed, the task is exactly
 * what it is for, and it is never opened. Attaching it to a role instead is the other failure: it is then in
 * every prompt for every task, including the ones it has nothing to say about.
 *
 * So the match is made HERE, from the task text, before the agent runs. A skill's `description` is written to
 * say when it applies — impeccable's lists the surfaces and concerns it covers, and ends by naming what it is
 * NOT for — so matching against it is using the metadata for its stated purpose rather than guessing.
 *
 * Deterministic on purpose: no model call. Routing that costs a call would run on every task, and routing
 * whose answer varies between runs cannot be tested or trusted.
 */

/** Words that carry no signal about what a task is. */
const STOP = new Set([
  "use", "when", "the", "user", "wants", "and", "for", "with", "that", "this", "from", "into", "also", "not",
  "other", "otherwise", "improve", "covers", "handles", "should", "become", "than", "over", "onto", "your",
  "you", "are", "any", "all", "its", "their", "them", "they", "have", "has", "was", "were", "will", "would",
  "can", "may", "must", "such", "more", "most", "less", "very", "just", "only", "some", "each", "every",
  "make", "made", "making", "need", "needs", "needed", "want", "wanted", "work", "works", "working", "task",
  "tasks", "using", "used", "uses", "via", "per", "out", "off", "about", "after", "before", "then", "there",
  "where", "which", "while", "what", "who", "how", "why", "does", "did", "done", "get", "got", "let", "lets",
]);

/** A term long enough to mean something. Two-letter tokens match everything and nothing. */
const MIN_TERM = 3;

function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])
    .filter((t) => t.length >= MIN_TERM && !STOP.has(t));
}

/** Shortest shared prefix that counts as the same word. Below this, unrelated words start colliding. */
const MIN_SHARED = 4;

/**
 * Whether two words are the same word inflected.
 *
 * Matching by shared PREFIX rather than by reducing both to a stem, because stemming quietly gets it wrong in
 * exactly the cases that matter: a suffix-stripper turns "theming" into "them", which then fails to match
 * "theme" — a real miss on real text, and an invisible one, since a skill that fails to route looks identical
 * to a skill that correctly did not apply. A shared prefix has no such failure mode; it is only ever too
 * generous, and the length floor bounds that.
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  // A silent -e before a suffix breaks the prefix outright: "theme" and "theming" share only "them". Dropping
  // a trailing e before comparing is what makes that pair — and state/stating, style/styling — line up.
  const fold = (w: string): string => (w.endsWith("e") ? w.slice(0, -1) : w);
  const [x, y] = [fold(a), fold(b)];
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= MIN_SHARED && long.startsWith(short);
}

/**
 * A skill's own statement of what it is NOT for.
 *
 * impeccable ends its description with "Not for backend-only or non-UI tasks." Ignoring that sentence and
 * matching on the rest would route a design skill onto backend work — the skill told us not to, in the one
 * place it could.
 */
function exclusions(description: string): string[] {
  const m = /\bnot\s+for\s+([^.]+)/i.exec(description);
  return m ? terms(m[1]) : [];
}

/**
 * A skill that says it must be asked for by name.
 *
 * `pick-ui-library` ends its description with "Only runs when explicitly invoked; it does not trigger on its
 * own." Auto-routing it would break the contract the author wrote into the metadata — so the same sentence
 * that would let us match it is the sentence that forbids it.
 */
export function isExplicitOnly(description: string): boolean {
  return /\bonly\s+(runs?|use[sd]?|invoke[sd]?)\b[^.]*\bexplicit/i.test(description)
    || /\bdoes\s+not\s+trigger\s+on\s+its\s+own\b/i.test(description)
    || /\bonly\s+when\s+explicitly\s+(invoked|asked|requested)\b/i.test(description);
}

/**
 * A skill that plans or audits but refuses to write code.
 *
 * Several of these say so plainly — "Read-only on source code", "it proposes motion with exact values, it
 * does not implement it", "it plans improvements, it does not apply them". Handing one to an agent whose
 * whole job this turn is to implement puts the agent under two contradictory instructions, and the way that
 * failure shows up is an implementer that produces nothing. They are still right for a reviewer or a planner.
 */
export function isNonImplementing(description: string): boolean {
  return /\bread[- ]only\b/i.test(description)
    || /\bdoes\s+not\s+(implement|apply|execute|write)\b/i.test(description);
}

/** How much of a skill's vocabulary a task has to hit before the skill is worth its place in the prompt. */
export const MATCH_BAR = 3;
/** Never inline more than this many routed skills — each one is a full document in the prompt. */
export const MAX_ROUTED = 2;

export interface SkillMatch {
  name: string;
  /** Distinct description terms the task hit — the reason, so a routing decision can be explained. */
  hits: string[];
  score: number;
}

/**
 * Scores one skill against a task.
 *
 * Scoring counts DISTINCT description terms the task mentions, not total occurrences: a task repeating
 * "design" ten times is one signal, not ten, and rewarding repetition would let a single word carry a skill in.
 */
export function scoreSkill(task: string, description: string): { score: number; hits: string[] } {
  const taskTerms = new Set(terms(task));
  if (!taskTerms.size) return { score: 0, hits: [] };

  const task_ = [...taskTerms];
  const excluded = exclusions(description);
  // The exclusion clause is a veto, not a penalty: the skill said this is not its work.
  if (excluded.some((e) => task_.some((t) => sameWord(t, e)))) return { score: 0, hits: [] };

  const body = description.replace(/\bnot\s+for\s+[^.]+/i, "");
  const hits = [...new Set(terms(body))].filter((d) => task_.some((t) => sameWord(t, d)));
  return { score: hits.length, hits };
}

/**
 * The skills a task should carry, best match first.
 *
 * `already` is what the role already has attached — routing must not inline a document twice.
 */
export function routeSkills(
  task: string,
  registry: SkillRegistry,
  already: string[] = [],
  opts: { bar?: number; max?: number; role?: string; implementing?: boolean } = {},
): SkillMatch[] {
  const bar = opts.bar ?? MATCH_BAR;
  const have = new Set(already);
  // The ROLE is part of what is being asked. "Add a dark theme toggle" is ambiguous on its own; the same
  // sentence handed to `designer` is unambiguously interface work, and the skill's own exclusion clause is
  // what stops the role from dragging it onto work it does not cover.
  const subject = opts.role ? `${opts.role} ${task}` : task;
  return registry.list()
    .filter((s) => !have.has(s.name))
    // Both vetoes come from the skill's own description. Matching a skill on its words while ignoring the
    // words that say when NOT to use it would be reading half the metadata.
    .filter((s) => !isExplicitOnly(s.description))
    .filter((s) => !(opts.implementing && isNonImplementing(s.description)))
    .map((s) => ({ name: s.name, ...scoreSkill(subject, s.description) }))
    .filter((m) => m.score >= bar)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, opts.max ?? MAX_ROUTED);
}
