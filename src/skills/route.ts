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

/** A term long enough to mean something. Two-letter tokens usually match everything and nothing. */
const MIN_TERM = 3;

/**
 * Short terms that carry real meaning, exempt from the length floor.
 *
 * The floor exists because two-letter tokens are usually noise — but it was silently deleting the most
 * central word in this entire domain. A task saying "redesign the UI" scored ZERO against a description
 * saying "improve the UI of a page", and an Angular project's `ui/` directories contributed nothing.
 * Everything downstream then blamed the description or the bar.
 */
const SHORT_TERMS = new Set(["ui", "ux", "db", "js", "ts", "qa"]);

/**
 * Splits identifiers into words.
 *
 * Code names things `CheckoutFlow`, `retry_payment`, `OnboardingScreen`. Lower-casing those whole leaves one
 * long token that matches nothing a human writes, so a task saying "checkout flow" failed to reach
 * `CheckoutFlow` — the exact case file-path routing exists to catch.
 */
function splitIdentifiers(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")   // checkoutFlow → checkout Flow
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // HTTPServer   → HTTP Server
    .replace(/[_./-]+/g, " ");
}

function terms(text: string): string[] {
  return (splitIdentifiers(text).toLowerCase().match(/[a-z][a-z0-9]+/g) ?? [])
    .filter((t) => (t.length >= MIN_TERM || SHORT_TERMS.has(t)) && !STOP.has(t));
}

/**
 * How close to the best match a file has to be to be reported at all.
 *
 * Resolution is evidence for routing, not a search result: a handful of confident files helps, and a long
 * tail of files sharing one common word actively misleads.
 */
export const FILE_SCORE_RATIO = 0.5;
/** What counts as source. Documentation is in the graph too, and it is not what a task's work lands in. */
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|h|cc|cpp|hpp|cs|php|swift|kt|scala|css|scss|vue|svelte|sql)$/;
/** Below this a match is one common word and nothing more. */
export const MIN_FILE_SCORE = 1.0;

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
/**
 * Never inline more than this many routed skills — each one is a full document in the prompt.
 *
 * Three rather than two because a genuine near-tie was losing: on an animation review, two planning skills
 * scored 4 and 3 while the skill written for reviewing scored 3, and the alphabetical tie-break dropped it.
 * The cost is real — these documents run from 8 KB to 27 KB each — so this is a ceiling, not a target, and
 * the match bar is what keeps most tasks well under it.
 */
export const MAX_ROUTED = 3;

export interface SkillMatch {
  name: string;
  /** Distinct description terms the task hit — the reason, so a routing decision can be explained. */
  hits: string[];
  score: number;
  /**
   * Share of the skill's own vocabulary that the task hit.
   *
   * Separates a tight fit from a broad one at the same raw score. A sprawling description that lists every
   * surface it might ever cover will collect three incidental hits on almost any interface task; a short
   * description written for one job collects three only when that is the job.
   */
  density: number;
}

/**
 * Scores one skill against a task.
 *
 * Scoring counts DISTINCT description terms the task mentions, not total occurrences: a task repeating
 * "design" ten times is one signal, not ten, and rewarding repetition would let a single word carry a skill in.
 */
export function scoreSkill(task: string, description: string): { score: number; hits: string[]; density: number } {
  const taskTerms = new Set(terms(task));
  if (!taskTerms.size) return { score: 0, hits: [], density: 0 };

  const task_ = [...taskTerms];
  const excluded = exclusions(description);
  // The exclusion clause is a veto, not a penalty: the skill said this is not its work.
  if (excluded.some((e) => task_.some((t) => sameWord(t, e)))) return { score: 0, hits: [], density: 0 };

  const body = description.replace(/\bnot\s+for\s+[^.]+/i, "");
  const vocab = [...new Set(terms(body))];
  const hits = vocab.filter((d) => task_.some((t) => sameWord(t, d)));
  return { score: hits.length, hits, density: vocab.length ? hits.length / vocab.length : 0 };
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
  opts: {
    bar?: number; max?: number; role?: string; implementing?: boolean; files?: string[];
    /** Skills the product places deliberately — see `placed` below. */
    placed?: string[];
  } = {},
): SkillMatch[] {
  const bar = opts.bar ?? MATCH_BAR;
  const have = new Set(already);
  const placed = new Set(opts.placed ?? []);
  // The ROLE is part of what is being asked. "Add a dark theme toggle" is ambiguous on its own; the same
  // sentence handed to `designer` is unambiguously interface work, and the skill's own exclusion clause is
  // what stops the role from dragging it onto work it does not cover.
  // Directory names are evidence in their own right: a path through `components/` says what kind of work
  // this is even when the title does not.
  const paths = (opts.files ?? []).join(" ");
  const base = [opts.role ?? "", task, paths].filter(Boolean).join(" ");
  const subject = [base, expandExtensions(opts.files ?? []), expandAbbreviations(base)].filter(Boolean).join(" ");
  return registry.list()
    .filter((s) => !have.has(s.name))
    // Never propose a skill the product PLACES deliberately. Placement (`DEFAULT_ROLE_SKILLS`, and whatever
    // `/roles adjust` decided) and routing are two mechanisms for two different things: placement says "this
    // role always needs this", routing says "this task happens to need that". A skill managed by the first
    // being second-guessed by the second is how a brainstorming skill — whose description opens with "use
    // this before any creative work" — ended up inlined into an implementer building a component test.
    .filter((s) => !placed.has(s.name))
    // Both vetoes come from the skill's own description. Matching a skill on its words while ignoring the
    // words that say when NOT to use it would be reading half the metadata.
    .filter((s) => !isExplicitOnly(s.description))
    .filter((s) => !(opts.implementing && isNonImplementing(s.description)))
    .map((s) => ({ name: s.name, ...scoreSkill(subject, s.description) }))
    .filter((m) => m.score >= bar)
    // Ties break on DENSITY, not on the alphabet. Three skills tying at three hits is common, and picking
    // between them by name is picking at random: it is what kept `review-animations` out of an animation
    // review while `impeccable` — which lists every UI concern there is — took the slot on incidental hits.
    .sort((a, b) => b.score - a.score || b.density - a.density || a.name.localeCompare(b.name))
    .slice(0, opts.max ?? MAX_ROUTED);
}

/**
 * Translates a file extension into the words that describe it.
 *
 * An extension is the single strongest signal a path carries — `.tsx` has meant "interface component" for
 * years — and it is the one signal no skill description contains, because descriptions are written in
 * English ("frontend", "interface", "UI") and paths are written in file extensions. Without this bridge the
 * strongest evidence is the evidence that never matches.
 *
 * A small table of facts about file types, not a table of judgements about skills: `.tsx` is a component
 * whatever anyone thinks, so it does not drift the way a category mapping would.
 */
const EXT_WORDS: Record<string, string> = {
  tsx: "frontend interface component web",
  jsx: "frontend interface component web",
  vue: "frontend interface component web",
  svelte: "frontend interface component web",
  css: "frontend interface styling web",
  scss: "frontend interface styling web",
  html: "frontend interface web",
  sql: "database migration",
  proto: "protocol schema",
};

/**
 * Abbreviations that appear in paths but never in prose.
 *
 * Code writes `a11y/`, `i18n/`, `auth/`; a skill description writes "accessibility", "internationalization",
 * "authentication". Neither prefix matching nor a stemmer can bridge those — they are different words. This
 * cost a real match: an accessibility service resolved correctly to `core/a11y/live-announcer.service.ts`
 * and still failed to reach a skill that lists accessibility among its concerns.
 *
 * Facts about abbreviations, like the extension table — not judgements about skills.
 */
const ABBREVIATIONS: Record<string, string> = {
  a11y: "accessibility",
  i18n: "internationalization localization",
  l10n: "localization",
  auth: "authentication",
  ui: "interface",
  ux: "interface experience",
};

function expandAbbreviations(text: string): string {
  const out: string[] = [];
  for (const t of terms(text)) if (ABBREVIATIONS[t]) out.push(ABBREVIATIONS[t]);
  return out.join(" ");
}

export function expandExtensions(files: string[]): string {
  const words = new Set<string>();
  for (const f of files) {
    const ext = f.split(".").pop()?.toLowerCase();
    if (ext && EXT_WORDS[ext]) for (const w of EXT_WORDS[ext].split(" ")) words.add(w);
  }
  return [...words].join(" ");
}

/**
 * The files a task is likely to touch, resolved through the code graph.
 *
 * Routing on the task title alone is thin: "Add dark mode" is three words, and a title says nothing about
 * where the work lands. The graph does. Resolving the title's terms to graph symbols yields their source
 * paths, and a path is strong evidence of what kind of work this is — `src/components/Onboarding.tsx` says
 * interface far more reliably than any wording of the title.
 *
 * The paths are fed back in as plain text rather than mapped to categories through a table of our own,
 * because the vocabulary already lines up: skill descriptions talk about components, forms, dashboards and
 * styles, and so do real directory names. A table would be one more thing to keep in step with reality.
 */
export function filesForTask(
  task: string,
  graph: { nodes: { label: string; source_file?: string }[] } | undefined,
  max = 8,
): string[] {
  if (!graph) return [];
  const taskTerms = [...new Set(terms(task))];
  if (!taskTerms.length) return [];

  // How many distinct files each term appears in. A term used all over the codebase ("config", "skill",
  // "role") says almost nothing about WHICH file a task is about; a term in two files says a great deal.
  // Without this weighting the resolver returned whatever matched first, which measured at 9% precision
  // against real commits — worse than returning nothing, since a wrong path is fed onward as evidence.
  const df = new Map<string, Set<string>>();
  const fileTerms = new Map<string, Set<string>>();
  for (const n of graph.nodes) {
    // SOURCE files only. The graph also carries documentation, and doc filenames are full of rare tokens
    // (dates, slice names) which the weighting below rates as highly informative — so a design document
    // outranked the code the task actually changes. Routing wants to know what kind of CODE work this is.
    if (!n.source_file || !SOURCE_FILE.test(n.source_file)) continue;
    let ft = fileTerms.get(n.source_file);
    if (!ft) { ft = new Set(); fileTerms.set(n.source_file, ft); }
    for (const t of terms(n.label)) {
      ft.add(t);
      let files = df.get(t);
      if (!files) { files = new Set(); df.set(t, files); }
      files.add(n.source_file);
    }
  }
  const total = fileTerms.size;
  if (!total) return [];
  const weight = (t: string): number => {
    const n = df.get(t)?.size ?? 0;
    return n ? Math.log(total / n) : 0;
  };

  const scored: { file: string; score: number }[] = [];
  for (const [file, ft] of fileTerms) {
    let score = 0;
    for (const t of taskTerms) {
      // Same word-equality the rest of routing uses, so "onboarding" reaches an `OnboardingScreen`.
      const hit = [...ft].find((l) => sameWord(t, l));
      if (hit) score += weight(hit);
    }
    if (score > 0) scored.push({ file, score });
  }
  if (!scored.length) return [];

  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  // Only files close to the best match. A long tail of files sharing one common word is noise, and passing
  // noise on as evidence is the failure this replaced.
  const cut = scored[0].score * FILE_SCORE_RATIO;
  return scored.filter((s) => s.score >= cut && s.score >= MIN_FILE_SCORE).slice(0, max).map((s) => s.file);
}

/**
 * How far above the bar a match must be to be trusted without a second opinion.
 *
 * Measured on a real project: every false positive sat exactly AT the bar. "implement store crud methods"
 * and "configure ngrx signal store" each scored 3 against a design skill, on architecture words rather than
 * interface intent — a judgement word-overlap cannot make. Matches well clear of the bar were right; matches
 * at it were a coin toss. So this is where a model is worth asking, and only here.
 */
export const CONFIDENT_MARGIN = 2;

export interface Adjudication {
  keep: string[];
  reasoning?: string;
}

/** Splits matches into those that need no second opinion and those that do. */
export function partitionByConfidence(
  matches: SkillMatch[],
  bar = MATCH_BAR,
  margin = CONFIDENT_MARGIN,
): { confident: SkillMatch[]; borderline: SkillMatch[] } {
  const confident: SkillMatch[] = [];
  const borderline: SkillMatch[] = [];
  for (const m of matches) (m.score >= bar + margin ? confident : borderline).push(m);
  return { confident, borderline };
}
