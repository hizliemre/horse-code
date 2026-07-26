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
  `**rule** — a standing directive about how to work that should govern every agent, in any tool: language ` +
  `requirements, commit conventions, things never to do, review standards, style mandates. It must make ` +
  `sense with no knowledge of the original tool.\n` +
  `**fact** — durable knowledge about this project or user: stack, architecture decisions, service names, ` +
  `preferences. True regardless of who is working.\n` +
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
