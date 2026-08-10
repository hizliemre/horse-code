/**
 * The project's constitution, delivered to the roles it governs — in the part that applies to them.
 *
 * The document was written, amended, and read by nobody. Measured on a real project: 543 lines, 13 principles,
 * and its text reached no role's prompt at all — `phases.ts` referenced only its PATH, to tell the analyst
 * where to write it. Every agent that has ever followed it did so by opening the file on its own initiative,
 * which most roles never do. The start-up banner meanwhile says "Constitution: in place", which reads like it
 * is in force.
 *
 * Three of the defects fixed by hand in one evening — agents chaining shell commands, an agent touching the
 * environment, documentation and code drifting between languages — were already written down in that file.
 *
 * Handing over all of it is the obvious answer and the wrong one: 27,529 characters on every call, most of it
 * irrelevant to the card in hand. Measured by scope instead: an always-set of 2,956 characters, a backend
 * card 12,236, a frontend card 10,183, a reviewer 7,774.
 */

/** A rule block: one paragraph or list, under the heading that gives it its authority. */
export interface Rule {
  /** `VII` for a principle, or the section's title. What a pointer back to the document says. */
  section: string;
  heading: string;
  text: string;
}

/**
 * Where a rule applies. Fixed vocabulary, because both sides have to agree on it: the classifier writes
 * these, and a card's files are mapped onto the same words.
 */
export const SCOPES = ["always", "backend", "frontend", "data", "infra", "docs", "review", "spec", "test", "govern"] as const;
export type Scope = typeof SCOPES[number];

export interface ScopedRule extends Rule { scopes: Scope[] }

/**
 * The rationale is for the person deciding, not the agent obeying.
 *
 * Every principle ends with `*Gerekçe:*` explaining why it exists. An agent that has been handed the rule
 * does not need to be persuaded of it, and the full text is one file read away when it does.
 */
const RATIONALE = /^\s*\*(?:Gerekçe|Rationale):\*/i;

/** `### VII. Angular Modern Pattern Disiplini` → `VII`; a plain section keeps its whole title. */
function sectionOf(heading: string): string {
  const m = /^([IVXLC]+)\.\s/.exec(heading);
  return m ? m[1] : heading;
}

/**
 * Splits the document into rule blocks.
 *
 * By PARAGRAPH, not by heading, because a heading is too coarse a unit here. Measured on a real
 * constitution: principle IX carries the backend target version, the frontend quality gate AND "commands are
 * atomic — no `cd` prefix, no `&&` chain, no pipes", which binds every role that has a shell. Splitting by
 * heading forces a choice between shipping 3 KB of irrelevance to everyone and losing that rule entirely.
 */
export function parseConstitution(text: string): Rule[] {
  const out: Rule[] = [];
  let heading = "";
  let buf: string[] = [];
  const flush = (): void => {
    const block = buf.join("\n").trim();
    buf = [];
    if (!block || !heading || RATIONALE.test(block)) return;
    out.push({ section: sectionOf(heading), heading, text: block });
  };
  for (const line of text.split("\n")) {
    const h = /^#{2,3}\s+(.*)$/.exec(line);
    if (h) {
      flush();
      // "Core Principles" is a divider with no rules of its own; the principles under it carry their own.
      heading = /^core principles$/i.test(h[1].trim()) ? "" : h[1].trim();
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    buf.push(line);
  }
  flush();
  return out;
}

/**
 * What a piece of work is ABOUT, from the files it touches and the role doing it.
 *
 * Extensions rather than the project's own directory names: this has to answer for any repository, and a
 * path convention is the first thing that differs between two of them.
 */
const BY_EXT: [RegExp, Scope][] = [
  [/\.(cs|java|kt|go|py|rb|php|scala|rs)$/i, "backend"],
  [/\.(ts|tsx|js|jsx|html|css|scss|sass|less|vue|svelte)$/i, "frontend"],
  [/\.(sql)$|(^|\/)migrations?\//i, "data"],
  [/\.(tf|tfvars)$|(^|\/)(k8s|helm|charts|deploy|infra)\//i, "infra"],
  [/\.(md|mdx|adoc)$/i, "docs"],
];

/** Roles whose work is a scope in itself, whatever files it touches. */
const BY_ROLE: Record<string, Scope[]> = {
  "code-reviewer": ["review"],
  "principal-coder": ["review"],
  "senior-coder": ["review"],
  analyst: ["spec"],
  planner: ["spec"],
  brainstormer: ["spec"],
  tester: ["test"],
};

export function scopesForWork(opts: { role?: string; files?: string[]; title?: string }): Set<Scope> {
  const out = new Set<Scope>(["always"]);
  for (const s of BY_ROLE[opts.role ?? ""] ?? []) out.add(s);
  for (const f of opts.files ?? []) for (const [re, scope] of BY_EXT) if (re.test(f)) out.add(scope);
  return out;
}

/**
 * Longest the constitution block may get in one prompt.
 *
 * 14,000 was a guess made before anything had been labelled, and the first real labelling walked into it: on
 * a 25,666-character constitution a backend card selects 15,934 and a reviewer 16,758, so every backend
 * review would have dropped ~2,700 characters of rules that genuinely applied. A ceiling that cannot fit
 * what a normal card needs is not a budget, it is a silent edit of the constitution.
 *
 * 20,000 clears the measured worst case with room, and still refuses to hand over a document whole.
 */
export const MAX_CONSTITUTION_CHARS = 20_000;

export interface Selection { text: string; used: ScopedRule[]; dropped: ScopedRule[] }

/**
 * The rules that bind this piece of work, newest authority first.
 *
 * `always` is never dropped. A MUST that falls off the end silently is worse than no constitution at all,
 * because the document still says it and everyone believes it is in force — so what is cut is said out loud,
 * and what is cut is only ever scope-specific.
 */
export function selectRules(rules: ScopedRule[], scopes: Set<Scope>, max = MAX_CONSTITUTION_CHARS): Selection {
  const applies = (r: ScopedRule): boolean => r.scopes.some((s) => scopes.has(s));
  const always = rules.filter((r) => r.scopes.includes("always"));
  const scoped = rules.filter((r) => !r.scopes.includes("always") && applies(r));

  const used: ScopedRule[] = [...always];
  const dropped: ScopedRule[] = [];
  let size = used.reduce((n, r) => n + r.text.length, 0);
  for (const r of scoped) {
    if (size + r.text.length > max) { dropped.push(r); continue; }
    used.push(r);
    size += r.text.length;
  }
  return { text: render(used, dropped), used, dropped };
}

/** Grouped under their headings, so a rule keeps the authority its section gives it. */
function render(used: ScopedRule[], dropped: ScopedRule[]): string {
  if (!used.length) return "";
  const byHeading = new Map<string, string[]>();
  for (const r of used) byHeading.set(r.heading, [...(byHeading.get(r.heading) ?? []), r.text]);
  const body = [...byHeading].map(([h, texts]) => `## ${h}\n${texts.join("\n\n")}`).join("\n\n");
  const cut = dropped.length
    ? `\n\n(${dropped.length} further section(s) of the constitution apply to this work but did not fit: `
      + `${[...new Set(dropped.map((d) => d.section))].join(", ")}. Read them in the constitution if this `
      + `change goes near them.)`
    : "";
  return `\n\n# Project constitution — the rules that bind THIS work\n\n`
    + `These are binding, and they are the project's own words. Where they and anything else disagree, they `
    + `win. The full document is at \`.specify/memory/constitution.md\`.\n\n${body}${cut}`;
}

/**
 * Which scopes each rule belongs to, decided once per constitution and kept.
 *
 * A model call, not a keyword match. Lexical routing was measured on this very project and answered with 9%
 * precision — "product", "description" and "order" name something in every corner of an integration
 * codebase — and a MUST attached to the wrong card, or missed on the right one, is the failure this whole
 * mechanism exists to prevent. One call buys the answer for the life of the document.
 *
 * Keyed on the content, so an amendment re-classifies and nothing else does. Cached under horse-code's own
 * home rather than in the project: it is derived, and the project checkout is read, never written.
 */
export const CLASSIFY_PROMPT =
  "You are labelling the rules of a software project's constitution so each one can be handed to the agents "
  + "it actually binds.\n\n"
  + `For each rule, answer with the scopes it is ABOUT, from exactly this list: ${SCOPES.join(", ")}.\n\n`
  + "- `backend`, `frontend`, `data`, `infra`: it names code, files or tooling of that kind — a language, a "
  + "framework, a database, a deployment target.\n"
  + "- `spec`: it constrains what a specification or plan may say (the stack, the boundaries, the vocabulary).\n"
  + "- `review`: it is a gate a reviewer applies — what blocks a merge, how findings are reported.\n"
  + "- `test`: it is about verification and evidence.\n"
  + "- `govern`: it is about amending the constitution itself, and binds nobody else.\n"
  + "- `always`: it names NO particular kind of code. It is about how to work, how to talk to the user, or "
  + "what may never be done — so it binds every role on every task.\n\n"
  + "A rule may carry several scopes. `always` is a real answer, not a safe one: use it when the rule "
  + "genuinely mentions no kind of code, and NOT because you are unsure. If a rule is about backend code, "
  + "say `backend` — labelling it `always` sends it to everyone writing CSS.\n\n"
  + "Answer for EVERY index you are given, and for no others. Do not translate, summarise or rewrite "
  + "anything — you are only labelling.\n\n"
  + "Return {labels: [{index, scopes}]} via submit, one entry per rule, in the order given.";

/**
 * How many rules go in one call.
 *
 * All seventy went in one, and the answer came back at 437 output tokens — about half a list — so the rules
 * it never reached defaulted to `always` and the whole document ended up bound to every role. A short answer
 * is a complete answer; four calls once per constitution is not a cost worth protecting.
 */
export const CLASSIFY_BATCH = 20;

/**
 * Extra attempts per batch before its rules fall through to `always`.
 *
 * A batch is a fifth of the document and the answer is cached for the document's lifetime, so a call that
 * fails once decides how those twenty rules are treated forever. Measured live: one batch of four came back
 * with `finish_reason: null` and zero tokens either way — nothing to do with the answer, the call simply did
 * not happen. Two retries cost nothing on the path where the first attempt works, which is nearly all of them.
 */
export const CLASSIFY_RETRIES = 2;

/** What the model is shown: the rules, numbered, with the heading each sits under. */
export function classifyMessage(rules: Rule[], offset = 0): string {
  return rules.map((r, i) => `--- ${i + offset} --- (${r.heading})\n${r.text}`).join("\n\n");
}

/**
 * Applies what came back, and says what did not.
 *
 * An unlabelled rule still binds everyone — a MUST sent too widely is noise, one sent nowhere is not a rule
 * — but it is no longer silent. The first run of this labelled nothing and looked exactly like a run that
 * labelled everything `always` on purpose.
 */
export function applyLabels(
  rules: Rule[], labels: { index: number; scopes: string[] }[],
): { scoped: ScopedRule[]; unlabelled: number[] } {
  const known = new Set<string>(SCOPES);
  const byIndex = new Map(labels.map((l) => [l.index, l.scopes.filter((s) => known.has(s)) as Scope[]]));
  const unlabelled: number[] = [];
  const scoped = rules.map((r, i) => {
    const scopes = byIndex.get(i) ?? [];
    if (!scopes.length) unlabelled.push(i);
    return { ...r, scopes: scopes.length ? scopes : (["always"] as Scope[]) };
  });
  return { scoped, unlabelled };
}

/**
 * Whether a labelling is worth keeping, and what is wrong with it if not.
 *
 * `always` is the fallback for anything unlabelled, so a labelling that lost calls is indistinguishable — by
 * shape — from a document that genuinely binds everyone. It is distinguishable by SIZE: measured over four
 * runs of the same 70-rule constitution, three good ones put 13-14 blocks in `always` and the failed one put
 * 35. Half a document in `always` is not a constitution that happens to be universal, it is a labelling that
 * did not happen, and caching it makes that permanent.
 */
export const MAX_ALWAYS_SHARE = 0.35;

export function labellingLooksWrong(scoped: ScopedRule[]): string | undefined {
  if (!scoped.length) return undefined;
  const always = scoped.filter((r) => r.scopes.includes("always")).length;
  if (always > scoped.length * MAX_ALWAYS_SHARE) {
    return `${always} of ${scoped.length} rules came back as \`always\``;
  }
  return undefined;
}
