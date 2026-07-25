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
  opts: { load: number; max?: number; threshold?: number; role?: string; now?: number },
): MemoryEntry[] {
  const budget = hintBudget(opts.load, opts.max ?? 5);
  if (budget === 0) return [];
  const threshold = opts.threshold ?? 0.6;
  const now = opts.now ?? Date.now();
  return entries
    .filter((e) => !e.stale) // an anchored file changed → the claim is no longer trustworthy
    .filter((e) => !isExpired(e, now)) // short-lived scaffolding past its TTL
    .filter((e) => audienceMatches(e, opts.role)) // don't pay for another role's context
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

/** Renders selected memories as a compact hint block for injection into the request. */
export function renderMemoryHints(entries: MemoryEntry[]): string {
  return `[Relevant notes from earlier sessions]\n${entries.map((e) => `- ${e.text}`).join("\n")}`;
}
