import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashContent, traceDir } from "./trace.js";

/**
 * What the product IS, in its own terms — the context a per-file trace cannot derive from code.
 *
 * A tracer reading `src/pricing/tiers.ts` can say it maps plan identifiers to limits. It cannot say that the
 * limits are what the free tier exists to enforce, because nothing in that file says so. That knowledge lives
 * in the README, the specs and the design docs, and until an agent has it, every answer about *why* the code
 * is shaped this way is a guess.
 *
 * So the documents are read ONCE into a single brief, and the brief is then handed to every tracer. One call
 * to establish the domain, rather than every tracer paying to re-read the README and reaching its own
 * conclusion — which would be both expensive and inconsistent between files.
 */

export const BRIEF_FILE = "PROJECT.md";
export const BRIEF_META = "PROJECT.json";

/** Documents that describe the product rather than implement it, best first. */
const DOC_PATTERNS: RegExp[] = [
  /^readme(\.md)?$/i,
  /**
   * A project's own index, before anything else under `docs/`.
   *
   * Selection was pattern order then file order, so `docs/` was read alphabetically: on a real repository
   * that meant the brief would have been built from BACKUP_STRATEGY, DEPLOYMENT_GUIDE and an e-invoicing
   * appendix, while `docs/architecture/00-INDEX.md` — the document that actually says what the system is —
   * never reached the budget. An index is the one document written to be read first.
   */
  /(^|\/)(00-)?index\.md$/i,
  /(^|\/)(architecture|overview)\.md$/i,
  /^(docs?|specs?)\/.*\.mde?$/i,
  /^\.specify\/memory\/constitution\.md$/i,
  /^specs\/[^/]+\/(spec|brainstorm|plan)\.md$/i,
  /^(contributing|architecture|design|domain|glossary)\.md$/i,
  /^docs?\/.*\.(md|txt)$/i,
];

/** How much document text the brief is built from. Beyond this the extra pages stop changing the answer. */
export const MAX_BRIEF_INPUT_CHARS = 120_000;
/** Per-document cap, so one enormous file cannot crowd out every other source. */
export const MAX_DOC_CHARS = 20_000;

export interface BriefMeta {
  /** Hash of the documents it was built from — the brief is stale when they change. */
  hash: string;
  sources: string[];
  writtenAt: number;
  model?: string;
}

export function briefPath(cwd: string): string {
  return join(traceDir(cwd), BRIEF_FILE);
}

/** Picks the documents worth reading, best first. */
export function selectDocs(files: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pattern of DOC_PATTERNS) {
    for (const f of files) {
      if (seen.has(f) || !pattern.test(f)) continue;
      // Generated and vendored trees describe someone else's product.
      if (/(^|\/)(node_modules|dist|build|vendor|\.horsecode|graphify-out|CHANGELOG)/i.test(f)) continue;
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

export interface BriefInput {
  sources: { file: string; text: string }[];
  hash: string;
  chars: number;
}

/** Reads the selected documents, within budget. Returns undefined when the project documents nothing. */
export async function gatherBriefInput(cwd: string, files: string[]): Promise<BriefInput | undefined> {
  const picked = selectDocs(files);
  const sources: { file: string; text: string }[] = [];
  let chars = 0;
  for (const file of picked) {
    if (chars >= MAX_BRIEF_INPUT_CHARS) break;
    let text: string;
    try { text = await readFile(join(cwd, file), "utf8"); } catch { continue; }
    if (!text.trim()) continue;
    const clipped = text.length > MAX_DOC_CHARS ? `${text.slice(0, MAX_DOC_CHARS)}\n…[truncated]` : text;
    sources.push({ file, text: clipped });
    chars += clipped.length;
  }
  if (!sources.length) return undefined;
  return { sources, hash: hashContent(sources.map((s) => `${s.file}:${s.text}`).join("\n")), chars };
}

/** The instruction that turns documents into a brief. */
export function briefPrompt(input: BriefInput): string {
  const body = input.sources.map((s) => `### ${s.file}\n${s.text}`).join("\n\n");
  return `Read this project's own documentation and write the briefing an engineer would want on their first ` +
    `day, before touching any code.\n\n` +
    `At most 400 words, under these exact headings:\n` +
    `**What it is** — the product, in one or two sentences: what it does and for whom.\n` +
    `**Domain concepts** — the nouns this project's people use and what each one means here. Only terms the ` +
    `documents actually define or use consistently; this is a glossary, not a summary.\n` +
    `**Rules that matter** — business rules, constraints and invariants stated in the documents that code ` +
    `must not violate. Quote the constraint, not your paraphrase of its importance.\n` +
    `**Deliberate choices** — decisions the documents record along with their reasons, so they are not undone ` +
    `by someone who never saw the reason.\n\n` +
    `Rules:\n` +
    `- Use ONLY what these documents state. If they do not say who the users are, do not invent them.\n` +
    `- Omit a heading entirely rather than filling it with something plausible.\n` +
    `- No preamble and no closing summary.\n\n` +
    `Documents:\n\n${body}`;
}

export async function saveBrief(cwd: string, body: string, meta: BriefMeta): Promise<void> {
  await mkdir(traceDir(cwd), { recursive: true });
  await writeFile(briefPath(cwd), `# Project brief\n\n${body.trim()}\n`, "utf8");
  await writeFile(join(traceDir(cwd), BRIEF_META), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

export async function loadBriefMeta(cwd: string): Promise<BriefMeta | undefined> {
  try { return JSON.parse(await readFile(join(traceDir(cwd), BRIEF_META), "utf8")) as BriefMeta; } catch { return undefined; }
}

/** The brief's text, for handing to a tracer or an agent. */
export function readBriefSync(cwd: string): string | undefined {
  try { return readFileSync(briefPath(cwd), "utf8"); } catch { return undefined; }
}

/**
 * The brief condensed for a trace prompt.
 *
 * A tracer needs the domain vocabulary, not the whole briefing: the full text in every one of a few hundred
 * prompts is the same paragraphs paid for a few hundred times.
 */
export const MAX_BRIEF_IN_PROMPT = 1200;
export function briefForPrompt(cwd: string): string | undefined {
  const b = readBriefSync(cwd);
  if (!b) return undefined;
  const body = b.replace(/^# Project brief\s*/, "").trim();
  return body.length > MAX_BRIEF_IN_PROMPT ? `${body.slice(0, MAX_BRIEF_IN_PROMPT)}…` : body;
}

export interface BriefStatus {
  built: boolean;
  /** True when the documents it was built from have changed since. */
  stale: boolean;
  sources: string[];
  builtAt?: number;
  /** Documents that are new or changed since the brief — what makes it stale, so the claim is checkable. */
  changed: string[];
}

/**
 * Whether the brief still describes the project.
 *
 * A brief that silently rots is worse than none: it is committed, it reads as established fact, and every
 * trace written after it inherits whatever it got wrong. The graph already tracks its own freshness; this is
 * the same obligation for the half that cost tokens to produce.
 */
export async function briefStatus(cwd: string, files: string[]): Promise<BriefStatus> {
  const meta = await loadBriefMeta(cwd);
  if (!meta || !readBriefSync(cwd)) return { built: false, stale: false, sources: [], changed: [] };
  const now = await gatherBriefInput(cwd, files);
  if (!now) return { built: true, stale: false, sources: meta.sources, ...(meta.writtenAt ? { builtAt: meta.writtenAt } : {}), changed: [] };
  const stale = now.hash !== meta.hash;
  // Naming WHICH documents moved turns "stale" from an assertion into something the user can check.
  const before = new Set(meta.sources);
  const changed = stale
    ? [...now.sources.filter((s) => !before.has(s.file)).map((s) => s.file),
       ...meta.sources.filter((f) => !now.sources.some((s) => s.file === f)).map((f) => `${f} (gone)`)]
    : [];
  return {
    built: true,
    stale,
    sources: meta.sources,
    ...(meta.writtenAt ? { builtAt: meta.writtenAt } : {}),
    // An edit inside an unchanged set of files changes the hash without changing the list; say so rather
    // than reporting an empty reason.
    changed: stale && !changed.length ? ["the documents were edited"] : changed,
  };
}
