import { existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ensureGitignore, localOnly, sharedDerived, traceRootRel } from "./trace.js";
import { sortProjectDocs, totalBytes, classifyCalls, type DocCandidate } from "../migrate/project-docs.js";
import { MAX_CHUNK_CHARS } from "../migrate/extract.js";

/**
 * `/init` — making a project fit to be worked on, which for git means one thing: the right things committed.
 *
 * horse-code leaves two kinds of file in a repository and they are opposites. The traces and the community
 * names are KNOWLEDGE: they cost millions of tokens and an LLM pass to produce, they merge line by line, and
 * a clone that has them starts understanding the project instead of re-buying it. The graph and its AST cache
 * are DERIVED: rebuilt from the source in minutes, keyed to one checkout's paths and mtimes, and — in the
 * graph's case — a single 29 MB line that git cannot merge at all.
 *
 * Getting that wrong is silent in both directions, and both directions were measured on real projects. One
 * blocked `graphify-out/` wholesale and every clone paid to rebuild the graph. Another had no rule for the
 * cache at all, so `git add -A` after a build swept 711 files and 7.8 MB of one machine's mtimes into a
 * commit. Neither shows up as an error; both are found months later.
 *
 * So this exists to be run once per project, deliberately, and to say what it did and why — rather than
 * having the rules appear as a side effect of the first `/graph trace`, which is how a person ends up
 * looking at a modified `.gitignore` they did not ask for.
 */

/** Anything sizeable that git would sweep up, which neither list has an opinion about. */
export interface Unclaimed {
  path: string;
  files: number;
}

/** What a project already says about itself, waiting to be read. */
export interface Knowledge {
  /** Files a tool is known to write — `CLAUDE.md` and its siblings. Their path proves their purpose. */
  named: { label: string; bytes: number }[];
  /** The project's other markdown, worth reading for rules. */
  docs: DocCandidate[];
  /** Set aside, each with the reason — shown so the judgement can be argued with. */
  skipped: DocCandidate[];
}

export interface InitReport {
  /** True when `.gitignore` was actually edited — a project already set up gets no diff and is told so. */
  changed: boolean;
  /** Committed on purpose: the knowledge a clone would otherwise have to buy again. */
  kept: string[];
  /** Kept out on purpose: derived, machine-local, or unmergeable. */
  excluded: string[];
  /** Big untracked directories no rule claims — reported, never acted on. */
  unclaimed: Unclaimed[];
  /** What the project already says about itself. Never imported without being asked — see `describeInit`. */
  knowledge?: Knowledge;
}

/**
 * Untracked weight that no rule covers.
 *
 * Reported rather than ignored, because this cannot know whether a directory is somebody's build output or
 * their actual work. What it can do is refuse to let 7.8 MB reach a commit unremarked — the failure that
 * prompted this command was exactly that, and it was invisible until someone read the diff.
 *
 * The threshold is in FILES rather than bytes: one large asset is a decision somebody made, while hundreds
 * of small ones in a directory nobody named is what a tool leaves behind.
 */
export const UNCLAIMED_FILE_FLOOR = 50;

/** Counts files under a directory, stopping once the floor is passed — a cache can hold hundreds of thousands. */
export function countFiles(dir: string, cap = UNCLAIMED_FILE_FLOOR * 4): number {
  let n = 0;
  const walk = (d: string): void => {
    if (n >= cap) return;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (n >= cap) return;
      if (e.isDirectory()) walk(join(d, e.name));
      else n++;
    }
  };
  walk(dir);
  return n;
}

/**
 * Makes the repository's rules match what horse-code writes, and reports the result.
 *
 * `ensureGitignore` is idempotent by construction, so running this on a project that has been through it
 * before is a no-op that says so. That matters more than it sounds: the reason to run `/init` twice is
 * usually that horse-code has LEARNED a rule since — the cache rule this command's own failure produced —
 * and a version that refused to look would never deliver it.
 */
export async function initProject(
  cwd: string,
  isIgnored: (path: string) => boolean,
  untracked: () => string[],
  /**
   * What the project already says about itself, if the caller looked.
   *
   * Passed in rather than gathered here: finding it means asking git for every file and another module for
   * which of them a tool is known to write, and this function's own job — the ignore rules — must keep
   * working in a directory that is not a repository at all.
   */
  knowledge?: Knowledge,
): Promise<InitReport> {
  const changed = await ensureGitignore(cwd);
  const unclaimed: Unclaimed[] = [];
  for (const rel of untracked()) {
    const path = join(cwd, rel);
    let dir = false;
    try { dir = statSync(path).isDirectory(); } catch { continue; }
    if (!dir || isIgnored(rel)) continue;
    const files = countFiles(path);
    if (files >= UNCLAIMED_FILE_FLOOR) unclaimed.push({ path: rel, files });
  }
  return {
    changed,
    kept: [`${traceRootRel().replace(/\\/g, "/")}/`, ...sharedDerived()].filter((p) => existsSync(join(cwd, p)) || p.endsWith("/")),
    excluded: localOnly(),
    unclaimed: unclaimed.sort((a, b) => b.files - a.files),
    ...(knowledge ? { knowledge } : {}),
  };
}

/** Whether there is anything to import at all — the question is not worth asking otherwise. */
export function hasKnowledge(k?: Knowledge): boolean {
  return !!k && (k.named.length > 0 || k.docs.length > 0);
}

/** "109 KB", "6.8 MB" — sizes a person can weigh a decision with. */
export function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * The question `/init` asks before spending anything.
 *
 * Costed in the extractor's own unit, because the number IS the argument for asking. Measured on a real
 * project: the named files came to 109 KB, and the rest of its markdown to 6.8 MB — roughly 850
 * classification calls to produce the 25 rules the consolidation keeps. Nobody should discover that
 * afterwards.
 */
export function describeKnowledge(k: Knowledge, chunk = MAX_CHUNK_CHARS): string {
  const lines: string[] = ["", "**This project already says things about itself.**", ""];
  if (k.named.length) {
    lines.push(`Files a tool is known to write — ${size(totalBytes(k.named.map((n) => ({ path: n.label, bytes: n.bytes }))))}:`);
    lines.push(...k.named.map((n) => `  · \`${n.label}\` (${size(n.bytes)})`));
  }
  if (k.docs.length) {
    const bytes = totalBytes(k.docs);
    lines.push("", `The project's other markdown — ${k.docs.length} file(s), ${size(bytes)}, about ${classifyCalls(bytes, chunk)} classification call(s):`);
    lines.push(...k.docs.slice(0, 8).map((d) => `  · \`${d.path}\` (${size(d.bytes)})`));
    if (k.docs.length > 8) lines.push(`  · …and ${k.docs.length - 8} more`);
  }
  if (k.skipped.length) {
    /**
     * Shown, with the reason, because setting a file aside by its NAME is a judgement. A project that keeps
     * its standards in `docs/archive` gets the wrong answer here, and the only way to argue with a judgement
     * is to see it.
     */
    const reasons = new Map<string, number>();
    for (const sk of k.skipped) reasons.set(sk.skipped ?? "", (reasons.get(sk.skipped ?? "") ?? 0) + 1);
    lines.push("", `Set aside — ${k.skipped.length} file(s), ${size(totalBytes(k.skipped))}:`);
    for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1])) lines.push(`  · ${n} × ${why}`);
  }
  return lines.join("\n");
}

/** What the person is shown. States the reasons, because the rules are only defensible with them. */
export function describeInit(report: InitReport): string {
  const lines: string[] = [
    report.changed
      ? "**Project set up for horse-code** — `.gitignore` updated."
      : "**Project is already set up** — `.gitignore` already says everything needed.",
    "",
    "Committed on purpose, because a clone would otherwise pay to produce it again:",
    ...report.kept.map((p) => `  · \`${p}\``),
    "",
    "Kept out on purpose — derived from the source, keyed to this checkout, or unmergeable:",
    ...report.excluded.map((p) => `  · \`${p}\``),
  ];
  if (report.unclaimed.length) {
    lines.push(
      "",
      "Untracked and covered by no rule — `git add -A` would commit these. Yours to decide:",
      ...report.unclaimed.map((u) => `  · \`${u.path}\` (${u.files >= UNCLAIMED_FILE_FLOOR * 4 ? `${u.files}+` : u.files} files)`),
    );
  }
  return lines.join("\n");
}
