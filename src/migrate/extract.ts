import type { ChatRequest, Provider } from "../core/types.js";
import type { Finding } from "./discover.js";

/**
 * Turning another tool's instructions into ours — or deciding they cannot be.
 *
 * The dangerous half of migration. A CLAUDE.md is not a list of rules; it is prose mixing four different
 * things: standing directives that should govern every agent we run, facts about the project, instructions
 * about tools that only exist in Claude Code ("use the Task tool", "invoke the Skill tool before replying"),
 * and stale notes nobody removed. Importing it wholesale injects broken instructions into every prompt we
 * ever build, and the failure is invisible — agents simply behave slightly wrongly, forever.
 *
 * So each candidate is classified, and anything tool-specific is dropped WITH ITS REASON, so the user can
 * see what was left behind rather than discovering the gap later.
 */

export type Disposition = "rule" | "fact" | "skip";

export interface Candidate {
  /** The text as it would be stored — rewritten to stand alone, not the original line. */
  text: string;
  disposition: Disposition;
  /** Why it was classified this way. For a skip, this is what the user needs in order to disagree. */
  reason: string;
  /** Which file it came from. */
  source: string;
}

export interface Extraction {
  candidates: Candidate[];
  /** Files that could not be processed, with why — never silently dropped. */
  failed: { source: string; error: string }[];
}

/** Facts to send per call. Large enough to be cheap, small enough that the model reads each one. */
export const BATCH = 20;

const SYSTEM =
  "You migrate instructions from one coding assistant to another. You are precise about what does and does " +
  "not transfer, and you never invent an instruction that was not there.";

/**
 * What a rule IS here, stated so the model does not import prose.
 *
 * horse-code injects rules into every agent's prompt, verbatim, forever. That is why the bar is a standing
 * directive about behaviour and not "anything that sounded instructional".
 */
const CLASSIFY = (body: string): string =>
  `Below is instruction material from a project that was developed with another coding assistant. It is being ` +
  `moved into a different assistant, which has its OWN tools, commands and agent model.\n\n` +
  `Classify every distinct instruction into exactly one of:\n\n` +
  `**rule** — a standing directive that must be obeyed on EVERY task, forever. Before choosing this, apply ` +
  `the test: would this still need saying on a task that has nothing to do with the section it came from? ` +
  `Language requirements, commit conventions, things never to do, security mandates pass that test. Process ` +
  `detail does NOT: "in phase 3 the implementer does X", "the plan document contains these sections", "run ` +
  `this before that" describe a procedure, and a procedure belongs in the knowledge that is recalled when ` +
  `relevant, not in the instructions of every agent on every task.\n` +
  `A rule is inlined into every prompt permanently, so a long list of them is itself a defect: expect only a ` +
  `handful from any document, and classify the rest as fact.\n` +
  `**fact** — durable knowledge about this project or user, INCLUDING its processes and conventions: stack, ` +
  `architecture decisions, workflow phases, service names, preferences. Recalled when relevant. This is the ` +
  `right home for most of what looks instructional.\n` +
  `**skip** — anything that only means something in the original tool: named tools, slash commands, ` +
  `subagent types, file paths of that tool's own config, its plugin or hook system. Also skip anything ` +
  `stale, empty, or purely descriptive of the document itself.\n\n` +
  `Rules for your output:\n` +
  `- REWRITE each kept item so it stands alone, in English, without referring to the original tool. If it ` +
  `cannot survive that rewrite, it is a skip.\n` +
  `- Do NOT merge distinct instructions, and do NOT invent any that are not present.\n` +
  `- For every skip, say in one short phrase WHAT made it tool-specific — the user decides whether to ` +
  `disagree, and cannot do that without the reason.\n` +
  `- Prefer skip when unsure. A wrong rule is applied to every task forever; a missed one can be added later.\n\n` +
  `Answer with a fenced json block:\n` +
  `{"items":[{"text":"...","disposition":"rule|fact|skip","reason":"..."}]}\n\n` +
  `Material:\n\n${body}`;

function parseItems(text: string): { text: string; disposition: string; reason?: string }[] | undefined {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fence ? fence[1] : text.slice(text.indexOf("{"));
  try {
    const parsed = JSON.parse(raw) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return undefined;
    return parsed.items.filter((i): i is { text: string; disposition: string; reason?: string } =>
      typeof i === "object" && i !== null
      && typeof (i as { text?: unknown }).text === "string"
      && typeof (i as { disposition?: unknown }).disposition === "string");
  } catch {
    return undefined;
  }
}

async function ask(provider: Provider, model: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const req: ChatRequest = {
    model,
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
    tools: [],
  };
  let out = "";
  for await (const ev of provider.chat(req, signal ?? new AbortController().signal)) {
    if (ev.type === "text-delta") out += ev.text;
    else if (ev.type === "error") throw new Error(ev.message);
  }
  return out;
}

const DISPOSITIONS = new Set<Disposition>(["rule", "fact", "skip"]);

/**
 * Classifies one batch of material.
 *
 * A batch is one prompt, so batching decides both cost and quality: too large and the model stops reading
 * each item, too small and a 218-entry memory directory becomes 218 calls.
 */
export async function classify(opts: {
  provider: Provider;
  model: string;
  body: string;
  source: string;
  signal?: AbortSignal;
}): Promise<Candidate[]> {
  const items = parseItems(await ask(opts.provider, opts.model, CLASSIFY(opts.body), opts.signal));
  if (!items) throw new Error("the classification could not be read");
  return items
    .filter((i) => i.text.trim())
    .map((i) => ({
      text: i.text.trim(),
      disposition: (DISPOSITIONS.has(i.disposition as Disposition) ? i.disposition : "skip") as Disposition,
      reason: (i.reason ?? "").trim() || "no reason given",
      source: opts.source,
    }));
}

/**
 * Largest slice of prose sent in one classification call.
 *
 * A real project's CLAUDE.md was 53 KB of dense rules. Sent whole it took minutes and produced a wall of
 * output the model had visibly stopped reading carefully by the end. Instructions are organised under
 * headings, so headings are where it splits — a section is a coherent unit, and cutting mid-section would
 * separate a rule from the qualification that follows it.
 */
export const MAX_CHUNK_CHARS = 8_000;

/** Splits markdown at top-level-ish headings, packing sections up to the size cap. */
export function chunkProse(text: string, max = MAX_CHUNK_CHARS): string[] {
  const parts = text.split(/\n(?=#{1,3} )/);
  const out: string[] = [];
  let buf = "";
  for (const part of parts) {
    // A single section over the cap is emitted alone rather than split: better one oversized call than a
    // rule severed from its exception.
    if (part.length >= max) {
      if (buf.trim()) { out.push(buf); buf = ""; }
      out.push(part.slice(0, max * 2));
      continue;
    }
    if (buf.length + part.length > max) { out.push(buf); buf = part; }
    else buf += (buf ? "\n" : "") + part;
  }
  if (buf.trim()) out.push(buf);
  return out.filter((c) => c.trim());
}

/** Groups findings into batches small enough to be read carefully, keeping each one's origin. */
export function batches(findings: Finding[], size = BATCH): { body: string; source: string }[] {
  const out: { body: string; source: string }[] = [];
  // A rules file is prose, split at its own headings — see chunkProse.
  for (const f of findings.filter((x) => x.kind === "rules" && x.text)) {
    const chunks = chunkProse(f.text!);
    chunks.forEach((body, i) => out.push({
      body: `### ${f.label}${chunks.length > 1 ? ` (part ${i + 1}/${chunks.length})` : ""}\n${body}`,
      source: f.label,
    }));
  }
  // Memory files are already one fact each, so several fit in one prompt without losing anything.
  const mem = findings.filter((x) => x.kind === "memory" && x.text);
  for (let i = 0; i < mem.length; i += size) {
    const chunk = mem.slice(i, i + size);
    out.push({
      body: chunk.map((f) => `### ${f.label}\n${f.text!}`).join("\n\n"),
      source: `${chunk.length} remembered facts`,
    });
  }
  return out;
}

/**
 * Runs every batch, tolerating failures per batch.
 *
 * One unreadable file must not lose the other two hundred: a migration that aborts halfway leaves the user
 * with a partially-populated memory and no way to tell what is missing.
 */
export async function extractAll(opts: {
  provider: Provider;
  model: string;
  findings: Finding[];
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  concurrency?: number;
}): Promise<Extraction> {
  const jobs = batches(opts.findings);
  const candidates: Candidate[] = [];
  const failed: { source: string; error: string }[] = [];
  let done = 0;
  const queue = [...jobs];
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = queue.shift();
      if (!job || opts.signal?.aborted) return;
      try {
        candidates.push(...await classify({ ...opts, body: job.body, source: job.source }));
      } catch (e) {
        failed.push({ source: job.source, error: e instanceof Error ? e.message : String(e) });
      }
      opts.onProgress?.(++done, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 5, queue.length) }, worker));
  return { candidates, failed };
}

/** What the user is asked to approve, grouped so a 218-entry import is a few decisions and not two hundred. */
export function groupForReview(e: Extraction): { rules: Candidate[]; facts: Candidate[]; skipped: Candidate[] } {
  return {
    rules: e.candidates.filter((c) => c.disposition === "rule"),
    facts: e.candidates.filter((c) => c.disposition === "fact"),
    skipped: e.candidates.filter((c) => c.disposition === "skip"),
  };
}


/**
 * How many standing rules a project may end up with.
 *
 * Not a style preference. Every rule is inlined into every agent's prompt on every task, forever, so the
 * list is a permanent tax on the whole system. Migrating a real 53 KB instruction document produced 168
 * rule candidates — which would have been roughly 15 KB of text in every single call, and would have made
 * the genuinely important rules impossible to see among the process detail.
 */
export const MAX_RULES = 25;

/** Consolidated output: the rules that survived, and what was demoted rather than dropped. */
export interface Consolidation {
  rules: Candidate[];
  /** Candidates that were process detail after all — kept, as facts. */
  demoted: Candidate[];
}

const CONSOLIDATE = (items: string[], max: number): string =>
  `Below are ${items.length} candidate standing rules extracted from one project's instruction documents. ` +
  `They overlap heavily and many are procedure rather than principle.\n\n` +
  `Produce AT MOST ${max} rules. Each one is inlined into every agent's instructions on every task, ` +
  `forever, so the list is a permanent cost and must earn its size.\n\n` +
  `How to decide:\n` +
  `- MERGE candidates that say the same thing differently into one rule that covers both. Losing a ` +
  `distinction that matters is worse than a slightly longer rule.\n` +
  `- KEEP what would still need saying on a task unrelated to where it came from: language requirements, ` +
  `commit and branch conventions, security mandates, review standards, things never to do.\n` +
  `- DEMOTE the rest. Procedure ("in phase 3…", "the document contains these sections", step ordering) is ` +
  `real knowledge but belongs where it is recalled when relevant, not in every prompt. Demoting is not ` +
  `discarding — say which ones, and they are kept as facts.\n` +
  `- Do NOT invent a rule that is not in the list, and do not weaken one into a vague slogan.\n\n` +
  `Answer with a fenced json block:\n` +
  `{"rules":["<the consolidated rule>", …],"demoted":["<the exact original text>", …]}\n\n` +
  `Candidates:\n${items.map((t, i) => `${i + 1}. ${t}`).join("\n")}`;

/**
 * Reduces a pile of rule candidates to a list a project can actually carry.
 *
 * Runs across ALL candidates at once, because that is the only vantage point from which the duplication is
 * visible: a per-chunk classifier reading one section cannot know that six other sections said the same
 * thing in different words.
 *
 * On failure the candidates are returned unchanged — the caller then still shows the user a number, and a
 * large number is information rather than a silent truncation.
 */
export async function consolidateRules(opts: {
  provider: Provider;
  model: string;
  candidates: Candidate[];
  max?: number;
  signal?: AbortSignal;
}): Promise<Consolidation> {
  const max = opts.max ?? MAX_RULES;
  if (opts.candidates.length <= max) return { rules: opts.candidates, demoted: [] };

  const texts = opts.candidates.map((c) => c.text);
  try {
    const out = await ask(opts.provider, opts.model, CONSOLIDATE(texts, max), opts.signal);
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(out);
    const parsed = JSON.parse(fence ? fence[1] : out.slice(out.indexOf("{"))) as { rules?: unknown; demoted?: unknown };
    const rules = Array.isArray(parsed.rules) ? parsed.rules.filter((r): r is string => typeof r === "string") : [];
    if (!rules.length) throw new Error("no rules came back");
    const demotedText = new Set(Array.isArray(parsed.demoted)
      ? parsed.demoted.filter((d): d is string => typeof d === "string") : []);
    return {
      // The consolidated text is new, so the source is the whole set rather than any one file.
      rules: rules.slice(0, max).map((text) => ({
        text, disposition: "rule" as const, reason: "consolidated", source: "migration",
      })),
      // Anything the model named as demoted is kept as a fact; anything it simply did not mention was
      // merged into a surviving rule and is already represented.
      demoted: opts.candidates.filter((c) => demotedText.has(c.text))
        .map((c) => ({ ...c, disposition: "fact" as const, reason: "process detail, kept as knowledge" })),
    };
  } catch {
    return { rules: opts.candidates, demoted: [] };
  }
}
