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
