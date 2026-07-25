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

/** One job may teach at most this much. A run that "learned" ten things has really learned none. */
export const MAX_LEARNED = 5;
/** Evidence budget. Past this the extractor is skimming noise, not reading a story. */
export const MAX_EVIDENCE_CHARS = 6000;
/** The extractor is inferring, not transcribing — its output must always rank below what the user stated. */
export const EXTRACTED_CONFIDENCE = 0.75;

export const LearnedSchema = z.object({
  memories: z.array(z.object({
    text: z.string(),
    kind: z.enum(["fact", "lesson"]),
    /** Roles this is FOR, if it is genuinely role-specific. Omit for anything the whole project should know. */
    audience: z.array(z.string()).optional(),
    importance: z.number().min(0).max(1).optional(),
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
  return redact(lines.join("\n")).slice(0, MAX_EVIDENCE_CHARS);
}

/** Drops audience entries that name no real role — an unknown audience would hide the memory from everyone. */
export function sanitizeAudience(audience: string[] | undefined, knownRoles: Set<string>): string[] | undefined {
  const kept = (audience ?? []).filter((r) => knownRoles.has(r));
  return kept.length ? kept : undefined;
}

/**
 * Extracts what this job taught and writes it to memory. Returns the texts actually stored (empty is a normal,
 * common outcome). Never throws: memory is advisory, and a failed extraction must not turn a finished job into
 * a failed one.
 */
export async function consolidateJob(
  deps: TaskCycleDeps,
  ev: JobEvidence,
  cwd: string,
  knownRoles: Iterable<string> = [],
): Promise<string[]> {
  if (!deps.learnMemory) return [];
  const evidence = buildEvidence(ev);
  if (!ev.cards.some((c) => !c.id.startsWith("__"))) return []; // nothing actually ran
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
      `A job just finished in this project. Decide what it taught that is worth remembering for FUTURE, ` +
      `unrelated sessions.\n\n${evidence}\n\nReturn at most ${MAX_LEARNED} memories — an empty list is correct ` +
      `if this job taught nothing durable.` }],
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
    // The prompt forbids secrets; this enforces it. An unsupervised writer is never trusted on its own word.
    if (!text || looksSecret(text)) continue;
    const ok = await deps.learnMemory(text, m.kind, {
      learnedBy: "memory-keeper",
      confidence: EXTRACTED_CONFIDENCE,
      ...(m.importance !== undefined ? { importance: m.importance } : {}),
      ...(sanitizeAudience(m.audience, roles) ? { audience: sanitizeAudience(m.audience, roles)! } : {}),
    });
    if (ok) stored.push(text);
  }
  if (stored.length) deps.onMemory?.({ kind: "learned", texts: stored });
  return stored;
}
