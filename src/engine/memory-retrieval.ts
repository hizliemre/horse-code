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
  kind?: "fact" | "lesson"; // default "fact"; a "lesson" (learned from a correction/failure) weighs higher
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
  opts: { load: number; max?: number; threshold?: number },
): MemoryEntry[] {
  const budget = hintBudget(opts.load, opts.max ?? 5);
  if (budget === 0) return [];
  const threshold = opts.threshold ?? 0.6;
  return entries
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
