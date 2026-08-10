// Post-job memory extraction. Until now a memory only existed if the coach happened to tag one mid-conversation,
// so everything the pipeline learned the hard way — a task that needed three attempts, a convention every
// reviewer kept enforcing — evaporated when the job ended and was re-learned from scratch on the next run.
//
// Three properties make an UNSUPERVISED writer safe here:
//  1. add-only — it can never edit or delete an existing memory, so a bad run cannot damage the store;
//  2. bounded — a hard cap on how many memories one job may add, and on how much evidence it may read;
//  3. secret-guarded — evidence is redacted going in and output is rejected going out, because this store is
//     written to a file that is committed with the repo.

import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Card } from "../board/board.js";
import type { TaskCycleDeps } from "./task-types.js";
import type { MemoryProposal } from "./memory-proposals.js";

/** One job may teach at most this much. A run that "learned" ten things has really learned none. */
export const MAX_LEARNED = 5;
/** Evidence budget. Past this the extractor is skimming noise, not reading a story. */
export const MAX_EVIDENCE_CHARS = 6000;
/** How many existing memories the curator is shown for dedup context. */
export const MAX_EXISTING_SHOWN = 40;
/** The curator is inferring, not transcribing — its output must always rank below what the user stated. */
export const EXTRACTED_CONFIDENCE = 0.75;

export const LearnedSchema = z.object({
  memories: z.array(z.object({
    text: z.string(),
    kind: z.enum(["fact", "lesson"]),
    audience: z.array(z.string()).optional().describe(
      "Roles this is FOR, if it is genuinely role-specific. Omit it for anything the whole project should "
      + "know — a narrow audience on a general fact hides it from everyone else."),
    importance: z.number().min(0).max(1).optional().describe(
      "0 to 1. Around 0.9 for something that would cause real damage if forgotten (a hard project rule, a "
      + "trap that has already cost a run); around 0.5 for a useful convention; below 0.3 for detail that is "
      + "cheap to rediscover. This orders what survives when the store is trimmed."),
  })),
});

/**
 * Anything shaped like a credential. Deliberately broad: a false positive costs one dropped memory, a false
 * negative writes a secret into a file that gets committed and pushed.
 */
// NB: the PEM header sits OUTSIDE the \b group on purpose — it starts with a dash, so a leading word boundary
// can never match it and the pattern would silently never fire on a private key.
const SECRET_RE = /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{12,})|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
/** A key/value line that NAMES a secret, even when the value itself looks unremarkable. */
const SECRET_ASSIGN_RE = /\b(api[_-]?key|secret|password|passwd|token|credential|authorization|bearer)\b\s*[:=]\s*\S{6,}/i;

/** True when text must never be stored or shown to the extractor. */
export function looksSecret(text: string): boolean {
  return SECRET_RE.test(text) || SECRET_ASSIGN_RE.test(text);
}

/** Replaces secret-bearing lines wholesale — a partial mask still leaks length and prefix. */
export function redact(text: string): string {
  return text.split("\n").map((l) => (looksSecret(l) ? "[redacted]" : l)).join("\n");
}

export interface JobEvidence {
  /** What the user asked for (the refined prompt). */
  request: string;
  /** The finished board — titles, attempt counts, the notes reviewers wrote back. */
  cards: Card[];
  /** Findings the review deliberately did not block on. */
  deferred?: string[];
  /**
   * Raw signals review agents proposed during the job. These carry the most information and the least
   * trust — they come from narrow single-angle lenses, several on cheap model tiers. The curator treats them
   * as claims to verify and rewrite, never as text to store.
   */
  proposals?: MemoryProposal[];
}

/**
 * Renders the job into bounded, redacted evidence. Attempt counts and review notes are the signal: a task that
 * passed on the first try teaches nothing, a task that needed three teaches exactly what future runs must avoid.
 */
export function buildEvidence(ev: JobEvidence): string {
  const lines: string[] = [`Request: ${ev.request}`, "", "Tasks:"];
  for (const c of ev.cards) {
    if (c.id.startsWith("__")) continue; // synthetic cards (the revision pass) are not work items
    const attempts = c.attempts > 1 ? ` — took ${c.attempts} attempts` : "";
    lines.push(`- "${c.title}" [${c.column}]${attempts}`);
    for (const n of c.reviewNotes) lines.push(`  · reviewer: ${n}`);
  }
  if (ev.deferred?.length) {
    lines.push("", "Findings accepted without a fix:");
    for (const d of ev.deferred) lines.push(`- ${d}`);
  }
  if (ev.proposals?.length) {
    // Attributed on purpose: "the concurrency lens proposed this" is exactly the context that lets the curator
    // discount a narrow lens over-generalizing from the one thing it was told to look for.
    lines.push("", "UNVERIFIED proposals from review agents (claims to judge, not text to store):");
    for (const p of ev.proposals) lines.push(`- [${p.kind}, proposed by ${p.proposedBy}] ${p.text}`);
  }
  return redact(lines.join("\n")).slice(0, MAX_EVIDENCE_CHARS);
}

/** The memories already on file — shown to the curator so it updates the pool instead of duplicating it. */
function existingBlock(existing: string[]): string {
  if (!existing.length) return "";
  const shown = existing.slice(0, MAX_EXISTING_SHOWN);
  return `\n\nAlready in memory — do NOT propose anything that merely restates one of these:\n${shown.map((t) => `- ${t}`).join("\n")}`;
}

/** Drops audience entries that name no real role — an unknown audience would hide the memory from everyone. */
export function sanitizeAudience(audience: string[] | undefined, knownRoles: Set<string>): string[] | undefined {
  const kept = (audience ?? []).filter((r) => knownRoles.has(r));
  return kept.length ? kept : undefined;
}

/**
 * THE single write gate into memory for everything the pipeline produces.
 *
 * Review agents propose; nothing they wrote is ever stored as text. This curator reads their proposals
 * alongside the job's own evidence, judges each claim, rewrites what survives in its own words, and returns
 * only that. Returns the texts actually stored (empty is a normal, common outcome).
 *
 * Never throws: memory is advisory, and a failed curation must not turn a finished job into a failed one.
 */
export async function curateMemories(
  deps: TaskCycleDeps,
  ev: JobEvidence,
  cwd: string,
  knownRoles: Iterable<string> = [],
  existing: string[] = [],
): Promise<string[]> {
  if (!deps.learnMemory) return [];
  const proposed = ev.proposals?.length ?? 0;
  // Something must have actually happened: either real work ran, or an agent proposed something.
  if (!ev.cards.some((c) => !c.id.startsWith("__")) && !proposed) return [];
  let resolved;
  try {
    resolved = deps.roleRegistry.resolve("memory-keeper");
  } catch {
    return []; // role not configured (older config) → silently skip rather than fail the job
  }
  const opts: RoleAgentOptions = {
    provider: deps.provider, ...resolved,
    tools: new ToolRegistry(), // no tools: it reasons over the evidence it was handed, it does not go looking
    messages: [{ role: "user", content:
      `A job just finished in this project. Decide what — if anything — it taught that is worth remembering ` +
      `for FUTURE, unrelated sessions.\n\n${buildEvidence(ev)}${existingBlock(existing)}\n\n` +
      `Return at most ${MAX_LEARNED} memories, IN YOUR OWN WORDS. An empty list is correct if this job taught ` +
      `nothing durable — that is the most common answer.` }],
    permission: deps.permission, approve: deps.approve, cwd, signal: deps.signal,
  };
  let out;
  try {
    out = await runStructuredRole(opts, LearnedSchema);
  } catch {
    return []; // no structured response → learn nothing, lose nothing
  }
  const roles = new Set(knownRoles);
  const stored: string[] = [];
  for (const m of out.memories.slice(0, MAX_LEARNED)) {
    const text = m.text.trim();
    // The prompt forbids secrets; this enforces it. A writer is never trusted on its own word — not even this one.
    if (!text || looksSecret(text)) continue;
    const audience = sanitizeAudience(m.audience, roles);
    const ok = await deps.learnMemory(text, m.kind, {
      learnedBy: "memory-keeper",
      confidence: EXTRACTED_CONFIDENCE,
      ...(m.importance !== undefined ? { importance: m.importance } : {}),
      ...(audience ? { audience } : {}),
    });
    if (ok) stored.push(text);
  }
  // Reported together so the ratio is visible: "12 proposals → 1 stored" is the curator doing its job.
  if (stored.length || proposed) deps.onMemory?.({ kind: "curated", proposed, stored });
  return stored;
}
