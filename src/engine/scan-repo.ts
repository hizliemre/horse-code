import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { profileProject } from "./project-scan.js";
import type { ProjectProfile } from "./project-scan.js";

/** Manifests worth reading in full — they declare test runners and UI frameworks by name. */
const MANIFESTS = ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "Gemfile", "pom.xml", "build.gradle", "composer.json"];

/** Cap the listing so an enormous monorepo cannot make discovery slow or memory-hungry. */
export const MAX_FILES = 20_000;

function gitFiles(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    // git is the cheap way to get a listing that already respects .gitignore — node_modules, build output and
    // vendored trees would otherwise dominate the counts and make every project look like whatever it depends on.
    const child = spawn("git", ["ls-files"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => { if (out.length < 4_000_000) out += d.toString(); });
    child.on("error", () => resolve([]));
    child.on("close", (code) => resolve(code === 0 ? out.split("\n").filter(Boolean).slice(0, MAX_FILES) : []));
  });
}

/**
 * Establishes what kind of project `cwd` is.
 *
 * Never throws and never blocks for long: a repository we cannot read yields a profile whose facts are all
 * false, which withholds skills rather than assigning the wrong ones. Failing closed is right here — the cost
 * of a missing skill is a less-guided agent, while the cost of a wrong one is an agent confidently doing work
 * nobody asked for.
 */
export async function scanRepo(cwd: string): Promise<ProjectProfile> {
  const files = await gitFiles(cwd);
  const manifests: Record<string, string> = {};
  for (const name of MANIFESTS) {
    if (!files.includes(name)) continue;
    try { manifests[name] = await readFile(join(cwd, name), "utf8"); } catch { /* unreadable → just not evidence */ }
  }
  return profileProject(files, manifests);
}
