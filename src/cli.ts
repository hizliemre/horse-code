#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
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
import type { LineReader } from "./terminal.js";
import { runJob } from "./engine/job.js";
import type { JobResult, JobDeps } from "./engine/job.js";
import { runInit } from "./init.js";

export interface CliArgs {
  prompt: string;
  fromBranch?: string;
  jobName?: string;
  rounds?: number;
  revisionRounds?: number;
  noTui?: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  let fromBranch: string | undefined;
  let jobName: string | undefined;
  let rounds: number | undefined;
  let revisionRounds: number | undefined;
  let noTui: boolean | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--branch" || a === "-b") fromBranch = argv[++i];
    else if (a === "--job" || a === "-j") jobName = argv[++i];
    else if (a === "--rounds") rounds = Number(argv[++i]);
    else if (a === "--revision-rounds") revisionRounds = Number(argv[++i]);
    else if (a === "--no-tui") noTui = true;
    else rest.push(a);
  }
  return {
    prompt: rest.join(" "),
    ...(fromBranch !== undefined && { fromBranch }),
    ...(jobName !== undefined && { jobName }),
    ...(rounds !== undefined && { rounds }),
    ...(revisionRounds !== undefined && { revisionRounds }),
    ...(noTui !== undefined && { noTui }),
  };
}

export function renderResult(res: JobResult): string {
  if (res.kind === "chat") return res.response;
  if (res.kind === "rejected") return `Not approved (stopped at the ${res.stage} stage).`;
  const pr =
    res.wave.status === "completed"
      ? `PR: ${res.wave.pr.url}`
      : `Partial: ${res.wave.failed.length} failed, ${res.wave.skipped.length} skipped`;
  const rev = res.revision ? `\nrevision: ${res.revision.status}` : "";
  return `${res.report}\n\nStatus: ${res.wave.status} — ${pr}${rev}`;
}

// TUI opens only when both stdin and stdout are a TTY: if stdin is piped (echo x | hcode)
// Ink's Q&A crashes on setRawMode with a non-TTY stdin → fall back to plain mode in that case.
export function shouldUseTui(stdinTTY: boolean, stdoutTTY: boolean, noTui: boolean): boolean {
  return stdinTTY && stdoutTTY && !noTui;
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
  if (argv[0] === "init") {
    const { read, close } = nodeLineReader();
    try {
      await runInit({
        read,
        readFile: (p) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } },
        writeFile: (p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); },
        home: process.env.HOME ?? "",
        log: (s) => console.log(s),
      });
    } finally { close(); }
    return;
  }
  const args = parseArgs(argv);
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
  const fromBranch = args.fromBranch ?? (await currentBranch(cwd));
  const buildDeps = (read: LineReader): JobDeps =>
    buildJobDeps({
      config, provider, skillRegistry, manager, prAdapter,
      askHuman: makeAskHuman(read),
      approve: makeApprove(read),
      signal: new AbortController().signal,
    });
  const useTui = shouldUseTui(!!process.stdin.isTTY, !!process.stdout.isTTY, !!args.noTui);

  // No arguments + interactive TTY → TUI REPL (task-input loop).
  if (!args.prompt) {
    if (useTui) {
      const { runTuiRepl } = await import("./tui/app.js");
      await runTuiRepl({
        buildDeps,
        jobBase: { fromBranch, maxRounds: args.rounds ?? 3, ...(args.revisionRounds !== undefined && { revisionRounds: args.revisionRounds }) },
        formatResult: renderResult,
        model: config.model,
      });
      return;
    }
    console.error('usage: hcode "<prompt>" [--branch b] [--job j] [--rounds n] [--revision-rounds n] [--no-tui]  |  hcode (interactive TUI REPL)  |  hcode init');
    process.exitCode = 1;
    return;
  }

  const jobName = args.jobName ?? (toSlug(args.prompt) || "hcode-job");
  const job = {
    prompt: args.prompt, fromBranch, jobName,
    maxRounds: args.rounds ?? 3,
    ...(args.revisionRounds !== undefined && { revisionRounds: args.revisionRounds }),
  };

  if (useTui) {
    const { runTui } = await import("./tui/app.js"); // load ink only on the TUI branch
    const res = await runTui({ buildDeps, job });
    console.log(renderResult(res));
    return;
  }

  const { read, close } = nodeLineReader();
  try {
    const deps = buildDeps(read);
    const res = await runJob(deps, { ...job, askUser: makeAskUser(read) });
    console.log(renderResult(res));
  } finally {
    close(); // close stdin → don't leave the process hanging
  }
}

// Only run main when executed directly (bin); don't run it on import (test).
// realpathSync: with a global bin symlink (npm link/-g), argv[1]=symlink path while import.meta.url
// resolves to the real path → they wouldn't match and main would never run. Resolve the symlink to align them.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}
if (isMainModule()) {
  main(process.argv.slice(2)).catch((e) => {
    console.error("error:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
