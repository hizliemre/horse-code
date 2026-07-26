import { mkdir, rm, readFile, writeFile, readdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

/**
 * A skill installed from a git repository rather than shipped with horse-code.
 *
 * Some skills are worth using but not worth vendoring: they are large, they carry their own scripts, and they
 * are maintained upstream. Copying one into this repo would freeze it at the moment it was copied and make
 * every upstream fix a manual merge. Installing it instead keeps a single source of truth — upstream — and
 * makes "update" a real operation.
 */
export interface SkillSource {
  /** Registry name AND cache directory. Must be a plain identifier: it becomes a path. */
  name: string;
  /** GitHub "owner/repo". */
  repo: string;
  /** Directory inside the repo that holds SKILL.md. Omit when it is the repo root. */
  path?: string;
  /** Branch, tag or commit. Defaults to the repo's default branch. */
  ref?: string;
}

/** What was installed, recorded beside the skill so an update can tell whether anything actually changed. */
export interface InstalledSource extends SkillSource {
  /** The commit actually installed — the thing an update compares against. */
  sha: string;
  installedAt: number;
}

const PROVENANCE = ".horsecode-source.json";

/** Where external skills live. Deliberately under the user's home, NOT in this repo — they are not ours. */
export function externalSkillsDir(home: string): string {
  return join(home, ".horsecode", "skills");
}

/** A name becomes a directory, so it must not be able to escape one. */
export function validName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes("..");
}

/** A repo becomes part of a URL. */
function validRepo(repo: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo);
}

/**
 * Turns a GitHub URL into a source declaration.
 *
 * Accepts what a user actually pastes: the repo root, a `tree`/`blob` link deep inside it, with or without a
 * trailing `SKILL.md`. The skill's NAME is taken from the directory that holds SKILL.md, because that is what
 * the loader keys on — not from the repo, which may hold many skills.
 */
export function parseSkillUrl(url: string): SkillSource | undefined {
  const m = url.trim().replace(/\/+$/, "").match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?$/i);
  if (!m) return undefined;
  const [, owner, repoName, ref, rawPath] = m;
  const repo = `${owner}/${repoName.replace(/\.git$/, "")}`;
  // A link straight to the file is the same skill as a link to its directory.
  const path = (rawPath ?? "").replace(/\/?SKILL\.md$/i, "");
  const name = path ? path.split("/").filter(Boolean).pop()! : repoName.replace(/\.git$/, "");
  return {
    name,
    repo,
    ...(path ? { path } : {}),
    // A branch name in a tree URL is where the user was browsing, not necessarily a pin they want. Only keep
    // it when it is not the obvious default, so "update" keeps following the branch.
    ...(ref && ref !== "main" && ref !== "master" && ref !== "HEAD" ? { ref } : {}),
  };
}

/** Runs a command, resolving with its exit code and output. */
function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...(cwd ? { cwd } : {}), stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => resolve({ code: 1, err: e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, err }));
  });
}

export interface FetchDeps {
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/** Resolves a ref to a commit sha, so "did anything change?" has an answer. */
async function resolveSha(src: SkillSource, deps: FetchDeps): Promise<string> {
  const f = deps.fetch ?? globalThis.fetch;
  const ref = src.ref ?? "HEAD";
  const res = await f(`https://api.github.com/repos/${src.repo}/commits/${ref}`, {
    headers: { Accept: "application/vnd.github.sha" },
  });
  if (!res.ok) throw new Error(`cannot resolve ${src.repo}@${ref} (HTTP ${res.status})`);
  return (await res.text()).trim();
}

/** Reads what is currently installed for a skill, if anything. */
export async function installedSource(home: string, name: string): Promise<InstalledSource | undefined> {
  try {
    return JSON.parse(await readFile(join(externalSkillsDir(home), name, PROVENANCE), "utf8")) as InstalledSource;
  } catch {
    return undefined;
  }
}

export interface InstallResult {
  name: string;
  sha: string;
  /** False when the installed commit already matched — nothing was downloaded twice. */
  changed: boolean;
}

/**
 * Installs (or updates) one external skill into the cache.
 *
 * The WHOLE subtree is taken, not just SKILL.md: a dispatcher's reference documents and any scripts it drives
 * are part of the skill. Having them on disk at a real path is also what lets a script-driven skill work at
 * all — it can be told its own base directory and run from there.
 */
export async function installSkillSource(home: string, src: SkillSource, deps: FetchDeps = {}): Promise<InstallResult> {
  if (!validName(src.name)) throw new Error(`skill source name is not a valid directory name: ${src.name}`);
  if (!validRepo(src.repo)) throw new Error(`skill source repo must be "owner/repo": ${src.repo}`);
  if (src.path?.includes("..")) throw new Error(`skill source path may not contain "..": ${src.path}`);

  const sha = await resolveSha(src, deps);
  const dest = join(externalSkillsDir(home), src.name);
  const current = await installedSource(home, src.name);
  if (current?.sha === sha && existsSync(join(dest, "SKILL.md"))) {
    return { name: src.name, sha, changed: false }; // already at this commit → nothing to do
  }

  const staging = join(tmpdir(), `hc-skill-${src.name}-${sha.slice(0, 8)}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    const url = `https://codeload.github.com/${src.repo}/tar.gz/${sha}`;
    const dl = await run("sh", ["-c", `curl -fsSL --max-time 120 ${JSON.stringify(url)} | tar xz -C ${JSON.stringify(staging)} --strip-components=1`]);
    if (dl.code !== 0) throw new Error(`download failed for ${src.repo}@${sha.slice(0, 8)}: ${dl.err.trim().slice(0, 200)}`);

    const from = src.path ? join(staging, src.path) : staging;
    if (!existsSync(join(from, "SKILL.md"))) {
      throw new Error(`${src.repo}${src.path ? `/${src.path}` : ""} has no SKILL.md`);
    }
    // Replace atomically enough: the old copy goes only after the new one is known good.
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    await cp(from, dest, { recursive: true });
    const record: InstalledSource = { ...src, sha, installedAt: (deps.now ?? Date.now)() };
    await writeFile(join(dest, PROVENANCE), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return { name: src.name, sha, changed: true };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Installs every configured source, reporting per-source outcomes. One failure never blocks the others. */
export async function syncSkillSources(
  home: string,
  sources: SkillSource[],
  deps: FetchDeps = {},
): Promise<{ ok: InstallResult[]; failed: { name: string; error: string }[] }> {
  const ok: InstallResult[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const src of sources) {
    try {
      ok.push(await installSkillSource(home, src, deps));
    } catch (e) {
      failed.push({ name: src.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { ok, failed };
}

/** Names of the external skills currently on disk (whether or not they are still configured). */
export async function cachedSkillNames(home: string): Promise<string[]> {
  try {
    const entries = await readdir(externalSkillsDir(home), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && existsSync(join(externalSkillsDir(home), e.name, "SKILL.md")))
      .map((e) => e.name);
  } catch {
    return [];
  }
}
