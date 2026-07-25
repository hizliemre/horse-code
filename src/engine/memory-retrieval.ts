// Embedding-free memory relevance: lexical scoring by anchors (paths/identifiers/commands) + informative
// tags, with a context-pressure-gated injection budget. Modeled on WrongStack's super-memory (no vectors).

/** Generic coding words that carry no retrieval signal (filtered out of tags). */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "you", "your", "our", "was", "are", "will",
  "use", "used", "using", "add", "added", "adds", "fix", "fixed", "make", "made", "set", "get", "run",
  "code", "file", "files", "function", "method", "class", "value", "return", "returns", "test", "tests",
  "should", "would", "could", "when", "then", "than", "have", "has", "had", "not", "but", "all", "any",
  "new", "old", "one", "two", "can", "may", "want", "need", "like", "just", "now", "how", "what", "why",
]);

const WORD_RE = /[A-Za-z][A-Za-z0-9]{2,}/g;

/** Derives exact-match anchors (paths, files, backticked terms, camel/snake identifiers) from text. */
export function deriveAnchors(text: string): string[] {
  const anchors = new Set<string>();
  for (const m of text.matchAll(/`([^`]+)`/g)) anchors.add(m[1].toLowerCase()); // `backticked`
  for (const m of text.matchAll(/[A-Za-z0-9_.\-/]*\/[A-Za-z0-9_.\-/]+/g)) anchors.add(m[0].toLowerCase()); // has a slash → path
  for (const m of text.matchAll(/\b[A-Za-z0-9_-]+\.[A-Za-z]{1,6}\b/g)) anchors.add(m[0].toLowerCase()); // file.ext
  for (const m of text.matchAll(/\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g)) anchors.add(m[0].toLowerCase()); // camelCase
  for (const m of text.matchAll(/\b[a-z]+_[a-z0-9_]+\b/g)) anchors.add(m[0].toLowerCase()); // snake_case
  return [...anchors];
}

/** Informative tag terms: content words minus stopwords and anything already captured as an anchor. */
export function deriveTags(text: string, anchors: string[]): string[] {
  const tags = new Set<string>();
  for (const m of text.toLowerCase().matchAll(WORD_RE)) {
    const w = m[0];
    if (STOPWORDS.has(w)) continue;
    if (anchors.some((a) => a.includes(w))) continue; // skip path/identifier fragments already in an anchor
    tags.add(w);
  }
  return [...tags];
}

export interface MemoryEntry {
  id: string;
  text: string;
  anchors: string[];
  tags: string[];
  createdAt: number;
  uses?: number; // reinforcement count — bumped when the model actually cites this memory
  // default "fact"; a "lesson" (from a correction/failure) weighs higher; a "rule" is a durable behavioral
  // directive (language/style/convention) that is ALWAYS injected (like a pin), not selected by relevance.
  kind?: "fact" | "lesson" | "rule";
  /**
   * Content fingerprint of each FILE anchor at the moment the memory was written. Without it a memory silently
   * rots: "auth lives in src/auth.ts and validates X" stays "true" long after that file changed. With it,
   * retrieval can tell that the anchored code moved on and stop injecting a claim that no longer holds.
   */
  anchorHashes?: Record<string, string>;
  /** Set when an anchor no longer verifies (file gone or content changed) → excluded from injection. */
  stale?: boolean;
  /**
   * Roles this memory is FOR. A lesson the code-reviewer learned about diff hygiene is noise for the refiner;
   * with 59 roles an unscoped pool means every agent pays for every other agent's context. Empty/absent = all.
   */
  audience?: string[];
  /** The role that recorded it — provenance, and the default audience hint when none is given. */
  learnedBy?: string;
  /**
   * How long it should live. `permanent` is never expired or pruned; `long` (default) survives indefinitely but
   * may be reviewed; `short` is session-scoped scaffolding that expires on its own.
   */
  persistence?: "permanent" | "long" | "short";
  /** Hard expiry (epoch ms). Past it the memory is neither injected nor listed. */
  expiresAt?: number;
}

/** Is this memory addressed to `role`? An unscoped memory is addressed to everyone. */
export function audienceMatches(entry: MemoryEntry, role?: string): boolean {
  if (!entry.audience?.length) return true;
  return role !== undefined && entry.audience.includes(role);
}

/** Has this memory passed its hard expiry? `permanent` never expires. */
export function isExpired(entry: MemoryEntry, now: number): boolean {
  if (entry.persistence === "permanent") return false;
  return entry.expiresAt !== undefined && entry.expiresAt <= now;
}

/** Default lifetime per persistence class (ms). `short` is scaffolding: useful this session, not next month. */
export const SHORT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Re-injection cooldown. Without it the same memory is re-sent on every turn that mentions its anchor: the
 * model already saw it, so the repeat buys nothing and costs tokens on every single call.
 */
export const INJECT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Tracks what has recently been injected, per consumer. Purely in-memory and per-session: a cooldown that
 * outlived the process would hide memories from a fresh conversation that has never seen them.
 */
export class InjectionLog {
  private readonly seen = new Map<string, number>();
  constructor(private readonly cooldownMs = INJECT_COOLDOWN_MS) {}

  /** True while this memory is still "recently shown" and should be skipped. */
  onCooldown(id: string, now: number): boolean {
    const at = this.seen.get(id);
    return at !== undefined && now - at < this.cooldownMs;
  }
  record(ids: string[], now: number): void {
    for (const id of ids) this.seen.set(id, now);
  }
  /** Drop the cooldown for a memory whose content changed — the model has not seen the new version. */
  invalidate(id: string): void {
    this.seen.delete(id);
  }
  clear(): void {
    this.seen.clear();
  }
}

/** Filesystem seam for anchor verification (injectable so the logic stays unit-testable). */
export interface AnchorFs {
  /** Content fingerprint of a project-relative path, or undefined when it does not exist / is unreadable. */
  fingerprint(relPath: string): string | undefined;
}

/** Anchors that look like file paths (contain a separator or a dotted extension) — the verifiable ones. */
export function fileAnchors(anchors: string[]): string[] {
  return anchors.filter((a) => /[/\\]/.test(a) || /\.[a-z0-9]{1,6}$/i.test(a));
}

/** Fingerprints every file anchor that currently exists → stored with the memory at write time. */
export function hashAnchors(anchors: string[], fs: AnchorFs): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of fileAnchors(anchors)) {
    const fp = fs.fingerprint(a);
    if (fp !== undefined) out[a] = fp;
  }
  return out;
}

/**
 * Re-checks a memory's file anchors. A memory goes stale when an anchored file disappeared or its content
 * changed since the memory was written — the claim was ABOUT that code, so it can no longer be trusted.
 * Memories with no verifiable anchor (a pure preference, a rule) are always considered fresh.
 */
export function verifyAnchors(entry: MemoryEntry, fs: AnchorFs): boolean {
  const hashes = entry.anchorHashes;
  if (!hashes) return true; // written before anchors were fingerprinted, or nothing verifiable
  for (const [path, was] of Object.entries(hashes)) {
    const now = fs.fingerprint(path);
    if (now === undefined || now !== was) return false;
  }
  return true;
}

/** Retrieval bonus for lessons — missing a lesson costs more than missing a preference. */
const LESSON_BONUS = 0.05;
const effectiveScore = (query: string, e: MemoryEntry): number =>
  scoreMemory(query, e) + (e.kind === "lesson" ? LESSON_BONUS : 0);

/** Lexical relevance of a memory to a query (0 = irrelevant). Anchor hit dominates; tags corroborate. */
export function scoreMemory(query: string, entry: MemoryEntry): number {
  const q = query.toLowerCase();
  const qWords = new Set(Array.from(q.matchAll(WORD_RE), (m) => m[0]));
  if (entry.anchors.some((a) => q.includes(a))) return 0.96; // exact anchor appears in the query
  const tagHits = entry.tags.filter((t) => qWords.has(t)).length;
  if (tagHits >= 2) return 0.88;
  if (tagHits === 1) return 0.6;
  return 0;
}

/** How many memory hints to inject given context pressure (higher load → fewer/none). */
export function hintBudget(load: number, max: number): number {
  if (load >= 0.95) return 0;
  if (load >= 0.82) return 1;
  if (load >= 0.65) return 3;
  return max;
}

/** Selects the most relevant memories for a query, capped by the pressure-gated budget. */
export function selectMemories(
  entries: MemoryEntry[],
  query: string,
  opts: { load: number; max?: number; threshold?: number; role?: string; now?: number; log?: InjectionLog },
): MemoryEntry[] {
  const budget = hintBudget(opts.load, opts.max ?? 5);
  if (budget === 0) return [];
  const threshold = opts.threshold ?? 0.6;
  const now = opts.now ?? Date.now();
  return entries
    .filter((e) => !e.stale) // an anchored file changed → the claim is no longer trustworthy
    .filter((e) => !isExpired(e, now)) // short-lived scaffolding past its TTL
    .filter((e) => audienceMatches(e, opts.role)) // don't pay for another role's context
    .filter((e) => !opts.log?.onCooldown(e.id, now)) // already shown recently → re-sending buys nothing
    .filter((e) => !entries.some((o) => contradicts(o, e))) // a newer same-topic memory says the opposite
    .map((e) => ({ e, score: effectiveScore(query, e) })) // lessons get a small bonus over equal-scored facts
    .filter((x) => x.score >= threshold)
    // ties broken by reinforcement (frequently-cited memories rank higher), then recency.
    .sort((a, b) => b.score - a.score || (b.e.uses ?? 0) - (a.e.uses ?? 0) || b.e.createdAt - a.e.createdAt)
    .slice(0, budget)
    .map((x) => x.e);
}

/** True when a reply actually references a memory (anchor hit or ≥2 tag hits) → used for reinforcement. */
export function memoryReferenced(entry: MemoryEntry, replyText: string): boolean {
  return scoreMemory(replyText, entry) >= 0.88;
}

/**
 * True when `next` supersedes `prev` — i.e. they are about the same thing, so the newer fact replaces the
 * older (prevents contradictory facts from accumulating). Same-topic = strong tag overlap, or a shared
 * anchor with corroboration.
 */
export function supersedes(next: MemoryEntry, prev: MemoryEntry): boolean {
  const sharedTags = next.tags.filter((t) => prev.tags.includes(t)).length;
  const sharedAnchor = next.anchors.some((a) => prev.anchors.includes(a));
  const minTags = Math.min(next.tags.length, prev.tags.length);
  if (minTags >= 2 && sharedTags >= Math.ceil(minTags * 0.6)) return true; // same-topic tags
  if (sharedAnchor && sharedTags >= 1) return true; // same anchor + at least one corroborating tag
  return false;
}

/**
 * A memory's lifecycle state, derived (not stored) so it can never drift from the facts:
 *  - `stale`        — an anchored file changed; the claim was about code that moved on
 *  - `expired`      — short-lived scaffolding past its TTL
 *  - `contradicted` — a same-topic memory of the SAME kind says something different and is newer
 *  - `active`       — injectable
 */
export type MemoryState = "active" | "stale" | "expired" | "contradicted";

/** Negation markers — a same-topic memory that flips one of these is contradicting, not merely updating. */
const NEGATION_RE = /\b(not|never|no longer|don'?t|do not|asla|değil|yok|hiç)\b/i;

/**
 * Does `later` contradict `earlier`? Same kind + same topic (the supersession test) + opposite polarity.
 * Supersession already replaces a same-topic memory on WRITE; this catches the pair that survived — e.g. two
 * memories about the same anchor where one says "X is safe" and a newer one says "X is NOT safe".
 */
export function contradicts(later: MemoryEntry, earlier: MemoryEntry): boolean {
  if ((later.kind ?? "fact") !== (earlier.kind ?? "fact")) return false;
  if (later.id === earlier.id || later.createdAt <= earlier.createdAt) return false;
  if (!supersedes(later, earlier)) return false; // not the same topic
  return NEGATION_RE.test(later.text) !== NEGATION_RE.test(earlier.text);
}

/** The lifecycle state of one entry, given the whole set (needed to spot contradictions). */
export function memoryState(entry: MemoryEntry, all: MemoryEntry[], now: number): MemoryState {
  if (entry.stale) return "stale";
  if (isExpired(entry, now)) return "expired";
  if (all.some((other) => contradicts(other, entry))) return "contradicted";
  return "active";
}

/** Renders selected memories as a compact hint block for injection into the request. */
export function renderMemoryHints(entries: MemoryEntry[]): string {
  return `[Relevant notes from earlier sessions]\n${entries.map((e) => `- ${e.text}`).join("\n")}`;
}
