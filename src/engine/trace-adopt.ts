import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { traceDir, traceRootRel, hashContent, type TraceIndex, type TraceRecord } from "./trace.js";

/**
 * Adopting the documentation a project already has.
 *
 * A repository that generates its own file-level documentation has already answered, for some of its code,
 * the question a trace asks. Measured on a real one: 58 subsystem documents citing 465 source paths, of
 * which 420 exist — and every one of those 420 is a file the code graph already knows, with no fuzzy
 * matching and nothing to guess.
 *
 * Re-deriving what those documents say would cost a model call per file and produce a second, worse account
 * that immediately starts drifting from the first. So they are INDEXED, not copied: the entry points at the
 * document, the document stays the only copy, and editing it updates the trace by construction.
 *
 * What this cannot do is judge quality. A document that mentions a file in passing is recorded as covering
 * it, which is a claim the reader can check and the writer can override by tracing that file anyway.
 */

/** Source paths as documents cite them: a repo-relative path with a code-ish extension. */
const REF = /(?:^|[\s`"'(\[])((?:src|tests?|libs?|apps?|packages?|toucan|integrators)\/[A-Za-z0-9_./-]+\.[A-Za-z]{1,5})(?=[\s`"')\].,;:]|$)/gm;

/** Documents whose own path is a source file plus `.md` are per-file traces, not project documents. */
function isPerFileTrace(rel: string, sourceFiles: Set<string>): boolean {
  return rel.endsWith(".md") && sourceFiles.has(rel.slice(0, -".md".length));
}

async function markdownUnder(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...await markdownUnder(abs, base));
    else if (e.name.toLowerCase().endsWith(".md")) out.push(relative(base, abs).split(sep).join("/"));
  }
  return out;
}

export interface Adoption {
  /** file → the document that covers it. */
  covered: Record<string, string>;
  /** Documents that turned out to cite nothing this repository has. */
  bare: string[];
}

/**
 * Reads the project documents sitting in the trace root and records which files they cover.
 *
 * `sourceFiles` is what the graph knows: a citation to something the graph has never seen is a typo, a moved
 * file or an illustration, and recording it would make a trace that resolves to nothing.
 */
export async function adoptDocs(cwd: string, sourceFiles: Set<string>): Promise<Adoption> {
  const root = traceDir(cwd);
  const rootRel = traceRootRel().split(sep).join("/");
  const covered: Record<string, string> = {};
  const bare: string[] = [];
  for (const rel of await markdownUnder(root)) {
    if (isPerFileTrace(rel, sourceFiles)) continue; // horse-code's own output, not a project document
    let text: string;
    try { text = await readFile(join(root, rel), "utf8"); } catch { continue; }
    const doc = `${rootRel}/${rel}`;
    let hits = 0;
    for (const m of text.matchAll(REF)) {
      const file = m[1];
      if (!sourceFiles.has(file)) continue;
      hits++;
      // First document wins: the ordering is the project's own (00-INDEX before 47-…), so the earliest
      // document is the most general account of that file, and re-pointing on every later mention would
      // leave a file described by whichever document happened to be read last.
      if (!covered[file]) covered[file] = doc;
    }
    if (!hits) bare.push(doc);
  }
  return { covered, bare };
}

/**
 * Folds an adoption into a trace index.
 *
 * The file's CURRENT hash is stored, exactly as a written trace stores it: a document that described the
 * file as it was is still a description of the file as it is, and when the file changes the entry goes stale
 * and the file becomes a candidate for tracing — which is the honest signal, and the one the project would
 * want anyway.
 */
export async function indexAdoption(
  cwd: string, index: TraceIndex, adoption: Adoption, read: (f: string) => Promise<string | undefined>,
): Promise<{ index: TraceIndex; added: number }> {
  const traces: Record<string, TraceRecord> = { ...index.traces };
  let added = 0;
  for (const [file, doc] of Object.entries(adoption.covered)) {
    if (traces[file]) continue; // a real trace, or an earlier adoption — never overwritten
    const text = await read(file);
    if (text === undefined) continue;
    traces[file] = { hash: hashContent(text), file, writtenAt: 0, doc };
    added++;
  }
  return { index: { ...index, traces }, added };
}

/** What was adopted, for the user — a claim they can check. */
export function describeAdoption(a: Adoption, added: number): string {
  const docs = new Set(Object.values(a.covered)).size;
  if (!added) return "No project documents cited files this repository has — nothing to adopt.";
  return `📚 Adopted **${added} file(s)** already described by ${docs} of the project's own document(s). `
    + `\`/graph trace\` will skip them; \`graph_trace\` serves the document itself.`
    + (a.bare.length ? `\n\n_${a.bare.length} document(s) cited no source file and were left alone._` : "");
}
