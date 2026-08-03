import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { toSlug } from "../worktree/slug.js";

export interface FeaturePaths { dir: string; brainstorm: string; spec: string; plan: string; tasks: string }

export function specsDir(workdir: string): string {
  return join(workdir, "specs");
}

export function constitutionPath(workdir: string): string {
  return join(workdir, ".specify", "memory", "constitution.md");
}

export function featurePaths(workdir: string, slug: string): FeaturePaths {
  const dir = join(specsDir(workdir), slug);
  return { dir, brainstorm: join(dir, "brainstorm.md"), spec: join(dir, "spec.md"), plan: join(dir, "plan.md"), tasks: join(dir, "tasks.md") };
}

/**
 * Where a verify run writes: beside the spec and the plan, never somewhere of its own.
 *
 * Everything one run produces belongs in one directory — that is what makes `specs/NNN-…` an account of a
 * piece of work rather than a pile of documents. The exceptions are the project's OWN documents (the code
 * graph, the per-file traces, the constitution), which describe the project rather than this run and live
 * where the project keeps them.
 */
export interface VerifyPaths { dir: string; plan: string; report: string }

export function verifyPaths(workdir: string, slug: string): VerifyPaths {
  const dir = join(specsDir(workdir), slug);
  return { dir, plan: join(dir, "test-plan.md"), report: join(dir, "test-report.md") };
}

/**
 * Words that say what is being DONE rather than what it is being done TO.
 *
 * Matching on them would put every verification a project ever runs into whichever folder happened to be
 * numbered first — "smoke tests for checkout" and "wallet balance tests" share only the word "tests", and
 * they are not the same work.
 */
const ACTIVITY_WORDS = new Set([
  "test", "tests", "testing", "smoke", "e2e", "verify", "verification", "verifying", "check", "checking",
  "run", "running", "continue", "continuing", "report", "session", "the", "for", "of", "a", "an", "and",
]);

const subjectWords = (slug: string): Set<string> =>
  new Set(slug.split("-").filter((w) => w.length > 2 && !ACTIVITY_WORDS.has(w)));

/**
 * The folder this work already has, or the next number when it has none.
 *
 * A verify run is usually the SECOND visit to a piece of work: it was built, and now its scenarios are being
 * run. Numbering a fresh directory for that would split one piece of work's account across two — the thing
 * the single-folder convention exists to prevent.
 *
 * Matching an exact name was not enough, because the same work is not asked for in the same words twice.
 * Measured across two runs minutes apart: "continue testing the product creation wizard" produced
 * `002-product-wizard-testing`, and "continue running the smoke tests for the product creation wizard"
 * produced `003-product-creation-wizard-smoke-tests` — one piece of work, two directories, and a third
 * waiting behind the next rephrasing.
 *
 * So the SUBJECT is compared: the words left after the ones naming the activity. Two shared subject words is
 * the threshold — one is a coincidence ("product list page" shares "product" with the wizard and is not it),
 * two is the same thing being talked about.
 */
export function featureSlugFor(workdir: string, title: string): string {
  const want = toSlug(title);
  const dir = specsDir(workdir);
  if (existsSync(dir)) {
    const names = readdirSync(dir);
    for (const name of names) {
      if (name.replace(/^\d+-/, "") === want) return name;
    }
    const wanted = subjectWords(want);
    let best: { name: string; shared: number } | undefined;
    for (const name of names) {
      const shared = [...subjectWords(name.replace(/^\d+-/, ""))].filter((w) => wanted.has(w)).length;
      if (shared >= 2 && (!best || shared > best.shared)) best = { name, shared };
    }
    if (best) return best.name;
  }
  return nextFeatureSlug(workdir, title);
}

/** Next feature slug "NNN-title": zero-padded, one past the highest existing specs/NNN- dir. */
export function nextFeatureSlug(workdir: string, title: string): string {
  const dir = specsDir(workdir);
  let max = 0;
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      const m = name.match(/^(\d+)-/);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return `${String(max + 1).padStart(3, "0")}-${toSlug(title)}`;
}

/** Creates the .specify/memory + specs/<slug> directories; returns the feature paths. */
export function scaffoldFeature(workdir: string, slug: string): FeaturePaths {
  const paths = featurePaths(workdir, slug);
  mkdirSync(paths.dir, { recursive: true });
  mkdirSync(join(workdir, ".specify", "memory"), { recursive: true });
  return paths;
}
