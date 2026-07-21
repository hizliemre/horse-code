#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config/config.js";
import { OmniRouteProvider } from "./providers/omniroute.js";
import { SkillRegistry } from "./skills/registry.js";
import { WorktreeManager } from "./worktree/manager.js";
import { defaultGitRunner } from "./worktree/git.js";
import { toSlug } from "./worktree/slug.js";
import { buildJobDeps } from "./wiring.js";
import { makePRAdapter, detectPlatform, defaultCmdRunner } from "./adapters/pr.js";
import { makeAskUser, makeApprove, makeAskHuman, nodeLineReader } from "./terminal.js";
import { runJob } from "./engine/job.js";
import type { JobResult } from "./engine/job.js";

export interface CliArgs {
  prompt: string;
  fromBranch?: string;
  jobName?: string;
  rounds?: number;
  revisionRounds?: number;
}

export function parseArgs(argv: string[]): CliArgs {
  let fromBranch: string | undefined;
  let jobName: string | undefined;
  let rounds: number | undefined;
  let revisionRounds: number | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--branch" || a === "-b") fromBranch = argv[++i];
    else if (a === "--job" || a === "-j") jobName = argv[++i];
    else if (a === "--rounds") rounds = Number(argv[++i]);
    else if (a === "--revision-rounds") revisionRounds = Number(argv[++i]);
    else rest.push(a);
  }
  return {
    prompt: rest.join(" "),
    ...(fromBranch !== undefined && { fromBranch }),
    ...(jobName !== undefined && { jobName }),
    ...(rounds !== undefined && { rounds }),
    ...(revisionRounds !== undefined && { revisionRounds }),
  };
}

export function renderResult(res: JobResult): string {
  if (res.kind === "chat") return res.response;
  if (res.kind === "rejected") return `Onaylanmadı (${res.stage} aşamasında durduruldu).`;
  const pr =
    res.wave.status === "completed"
      ? `PR: ${res.wave.pr.url}`
      : `Kısmi: ${res.wave.failed.length} başarısız, ${res.wave.skipped.length} atlandı`;
  const rev = res.revision ? `\nrevision: ${res.revision.status}` : "";
  return `${res.report}\n\nDurum: ${res.wave.status} — ${pr}${rev}`;
}

async function currentBranch(cwd: string): Promise<string> {
  try {
    const r = await defaultGitRunner(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    const b = r.stdout.trim();
    return b && b !== "HEAD" ? b : "main";
  } catch {
    return "main";
  }
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!args.prompt) {
    console.error('kullanım: hcode "<prompt>" [--branch b] [--job j] [--rounds n] [--revision-rounds n]');
    process.exitCode = 1;
    return;
  }
  const cwd = process.cwd();
  const config = loadConfig({
    cwd,
    home: process.env.HOME ?? "",
    env: process.env,
    readFile: (p) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } },
  });
  const provider = new OmniRouteProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey });
  const skillRegistry = new SkillRegistry();
  const skillsDir = join(cwd, ".horsecode", "skills");
  if (existsSync(skillsDir)) await skillRegistry.loadFromDir(skillsDir);
  const manager = new WorktreeManager({ repoRoot: cwd });
  const remoteUrl = (await defaultGitRunner(["remote", "get-url", "origin"], cwd)).stdout.trim();
  const prAdapter = makePRAdapter({ platform: detectPlatform(remoteUrl), run: defaultCmdRunner, cwd, log: (s) => console.log(s) });
  const { read, close } = nodeLineReader();
  try {
    const deps = buildJobDeps({
      config, provider, skillRegistry, manager,
      prAdapter,
      askHuman: makeAskHuman(read),
      approve: makeApprove(read),
      signal: new AbortController().signal,
    });
    const fromBranch = args.fromBranch ?? (await currentBranch(cwd));
    const jobName = args.jobName ?? (toSlug(args.prompt) || "hcode-job");
    const res = await runJob(deps, {
      prompt: args.prompt, fromBranch, jobName,
      askUser: makeAskUser(read), maxRounds: args.rounds ?? 3,
      revisionRounds: args.revisionRounds,
    });
    console.log(renderResult(res));
  } finally {
    close(); // stdin'i kapat → süreç asılı kalmasın
  }
}

// Yalnızca doğrudan çalıştırıldığında (bin) main'i koş; import (test) sırasında koşma.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error("hata:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
