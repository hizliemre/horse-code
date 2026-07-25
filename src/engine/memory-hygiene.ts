// Periodic memory maintenance. Writes happen one at a time and only ever compare the NEW entry against the
// pool (`supersedes`), so near-duplicates that arrive from different angles accumulate silently and each one
// keeps consuming retrieval slots. This pass reconciles the pool as a whole — and, deliberately, never deletes:
// anything questionable becomes a review candidate the user decides on.

import { confidenceOf, importanceOf, type MemoryEntry } from "./memory-retrieval.js";

/** Why a memory was put up for review. None of these ever delete on their own. */
export type ReviewReason = "expired" | "injected-never-used" | "low-confidence" | "long-stale";

export interface ReviewCandidate {
  id: string;
  text: string;
  reason: ReviewReason;
}

export interface MergeRecord {
  /** The surviving memory's id. */
  keeper: string;
  /** Texts of the duplicates folded into it (kept for the report so a merge is never silent). */
  absorbed: string[];
}

export interface HygieneReport {
  /** The reconciled pool — duplicates merged. Callers persist this. */
  entries: MemoryEntry[];
  merged: MergeRecord[];
  candidates: ReviewCandidate[];
}

const DAY = 24 * 60 * 60 * 1000;
/** A memory needs time to prove itself before its stats mean anything — these are the "old enough" bars. */
export const REVIEW_AGE_MS = 30 * DAY;
export const STALE_AGE_MS = 90 * DAY;
/** Injected this often with zero citations is evidence of noise, not of bad luck. */
export const UNUSED_INJECTIONS = 10;
export const LOW_CONFIDENCE = 0.5;

/**
 * Identity for dedup purposes: the same claim written twice with different punctuation or casing is one claim.
 * Deliberately lossy — it is only used to GROUP; the survivor keeps its original text verbatim.
 */
export function normalizeTextKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim();
}

const union = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])];

/**
 * Folds `loser` into `keeper`. The keeper absorbs the union of anchors/tags and the SUM of usage counts, so a
 * merge never loses retrieval reach or usage evidence — otherwise deduping would quietly make a well-used
 * memory look unused and set it up to be flagged as noise on the next pass.
 */
function absorb(keeper: MemoryEntry, loser: MemoryEntry): MemoryEntry {
  return {
    ...keeper,
    anchors: union(keeper.anchors, loser.anchors),
    tags: union(keeper.tags, loser.tags),
    uses: (keeper.uses ?? 0) + (loser.uses ?? 0),
    injections: (keeper.injections ?? 0) + (loser.injections ?? 0),
    importance: Math.max(importanceOf(keeper), importanceOf(loser)),
    confidence: Math.max(confidenceOf(keeper), confidenceOf(loser)),
    // The keeper's own fingerprints win: they describe the anchors its text was actually written against.
    anchorHashes: { ...loser.anchorHashes, ...keeper.anchorHashes },
    // A permanent duplicate makes the survivor permanent — the stronger claim on lifetime wins.
    ...(loser.persistence === "permanent" ? { persistence: "permanent" as const } : {}),
  };
}

/** Which of two same-claim memories survives: most important, then most cited, then the one established first. */
function betterKeeper(a: MemoryEntry, b: MemoryEntry): MemoryEntry {
  if (importanceOf(a) !== importanceOf(b)) return importanceOf(a) > importanceOf(b) ? a : b;
  if ((a.uses ?? 0) !== (b.uses ?? 0)) return (a.uses ?? 0) > (b.uses ?? 0) ? a : b;
  return a.createdAt <= b.createdAt ? a : b;
}

/** Flags a memory for human review. `permanent` memories are exempt: they were marked never-to-lapse. */
function reviewReason(e: MemoryEntry, now: number): ReviewReason | undefined {
  if (e.persistence === "permanent") return undefined;
  const age = now - e.createdAt;
  if (e.expiresAt !== undefined && e.expiresAt <= now) return "expired";
  if ((e.injections ?? 0) >= UNUSED_INJECTIONS && (e.uses ?? 0) === 0 && age >= REVIEW_AGE_MS) return "injected-never-used";
  if (confidenceOf(e) < LOW_CONFIDENCE && age >= REVIEW_AGE_MS) return "low-confidence";
  if (e.stale && age >= STALE_AGE_MS) return "long-stale";
  return undefined;
}

/**
 * Reconciles the pool: merges duplicates, then flags (never removes) entries that have stopped earning their
 * place. Pure — the caller persists `entries` and surfaces the report.
 */
export function hygiene(entries: MemoryEntry[], now: number): HygieneReport {
  const groups = new Map<string, MemoryEntry[]>();
  const order: string[] = [];
  for (const e of entries) {
    // Group by KIND too: a lesson and a fact that read alike are different claims about different things.
    const key = `${e.kind ?? "fact"}::${normalizeTextKey(e.text)}`;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key)!.push(e);
  }

  const merged: MergeRecord[] = [];
  const kept: MemoryEntry[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    if (group.length === 1) { kept.push(group[0]); continue; }
    const keeper = group.reduce(betterKeeper);
    const losers = group.filter((e) => e.id !== keeper.id);
    kept.push(losers.reduce(absorb, keeper));
    merged.push({ keeper: keeper.id, absorbed: losers.map((l) => l.text) });
  }

  const candidates: ReviewCandidate[] = [];
  for (const e of kept) {
    const reason = reviewReason(e, now);
    if (reason) candidates.push({ id: e.id, text: e.text, reason });
  }
  return { entries: kept, merged, candidates };
}

/** One-line human summary of a hygiene run, or undefined when it changed nothing worth reporting. */
export function hygieneSummary(r: HygieneReport): string | undefined {
  const parts: string[] = [];
  if (r.merged.length) parts.push(`merged ${r.merged.reduce((n, m) => n + m.absorbed.length, 0)} duplicate(s)`);
  if (r.candidates.length) parts.push(`${r.candidates.length} flagged for review`);
  return parts.length ? parts.join(", ") : undefined;
}
