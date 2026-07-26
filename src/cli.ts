#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config/config.js";
import { OmniRouteProvider } from "./providers/omniroute.js";
import { listOmniRouteModels } from "./providers/models.js";
import { SkillRegistry } from "./skills/registry.js";
import { registerBuiltinSkills } from "./skills/builtin.js";
import { externalSkillsDir, syncSkillSources, installSkillSource, parseSkillUrl } from "./skills/external.js";
import { saveSkillSource } from "./config/save-skills.js";
import { graphStatus, buildProjectGraph, graphifyPython } from "./engine/project-graph.js";
import { briefStatus } from "./engine/project-brief.js";
import { planFor, runTraces, describePlan, buildBrief } from "./engine/trace-run.js";
import { WorktreeManager } from "./worktree/manager.js";
import { defaultGitRunner } from "./worktree/git.js";
import { toSlug } from "./worktree/slug.js";
import { buildJobDeps } from "./wiring.js";
import { makePRAdapter, detectPlatform, defaultCmdRunner } from "./adapters/pr.js";
import { makeAskUser, makeApprove, nodeLineReader } from "./terminal.js";
import type { LineReader } from "./terminal.js";
import { autonomousAskHuman } from "./engine/escalation.js";
import { MemoryStore } from "./session/memory.js";
import { memoryNote } from "./engine/memory-inject.js";
import { runJob } from "./engine/job.js";
import type { JobResult, JobDeps } from "./engine/job.js";
import { runInit } from "./init.js";
import { DEFAULT_ROLE_SKILLS } from "./prompts.js";

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
    // symbolic-ref reports the branch name even on an unborn HEAD (fresh `git init`, e.g. "master"),
    // where rev-parse --abbrev-ref returns "HEAD". Getting the real name avoids guessing "main" wrongly.
    const sym = await defaultGitRunner(["symbolic-ref", "--short", "HEAD"], cwd);
    if (sym.code === 0 && sym.stdout.trim()) return sym.stdout.trim();
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
  const home = process.env.HOME ?? "";
  const skillRegistry = new SkillRegistry();
  // Built-ins FIRST, the project's own second: the registry is keyed by name, so a project skill with the
  // same name deliberately replaces the shipped one.
  await registerBuiltinSkills(skillRegistry);
  // Externally-installed skills (config.skillSources) live under the user's home, already on disk. Loading is
  // OFFLINE: startup never waits on the network — installing and updating are explicit acts (`/skills update`).
  await skillRegistry.loadFromDir(externalSkillsDir(home));
  const skillsDir = join(cwd, ".horsecode", "skills");
  if (existsSync(skillsDir)) await skillRegistry.loadFromDir(skillsDir);
  const manager = new WorktreeManager({ repoRoot: cwd });
  const remoteUrl = (await defaultGitRunner(["remote", "get-url", "origin"], cwd)).stdout.trim();
  const prAdapter = makePRAdapter({ platform: detectPlatform(remoteUrl), run: defaultCmdRunner, cwd, log: (s) => console.log(s) });
  const fromBranch = args.fromBranch ?? (await currentBranch(cwd));
  // ONE memory store for every entry point (REPL, one-shot TUI, headless). Rules live in memory, and rules must
  // reach every agent — so the store is created here, at the composition root, and handed to buildJobDeps.
  const memStore = new MemoryStore({ home, cwd });
  await memStore.load();
  await memStore.pruneExpired(); // short-lived scaffolding past its TTL never reaches a prompt
  const rules = (): string[] => memStore.all().filter((m) => m.kind === "rule").map((m) => m.text);
  const buildDeps = (read: LineReader): Promise<JobDeps> =>
    buildJobDeps({
      config, provider, skillRegistry, manager, prAdapter, rules,
      // Autonomous by default: a task that exhausts the escalation ladder is auto-retried (then abandoned) so
      // an unattended run finishes on its own instead of blocking on an interactive per-failure human prompt.
      askHuman: autonomousAskHuman(),
      approve: makeApprove(read),
      signal: new AbortController().signal,
      home,
    });
  const useTui = shouldUseTui(!!process.stdin.isTTY, !!process.stdout.isTTY, !!args.noTui);

  // No arguments + interactive TTY → TUI REPL (task-input loop).
  if (!args.prompt) {
    if (useTui) {
      const { runTuiRepl } = await import("./tui/app.js");
      const { fetchCatalog, makeProbe, discoverSources } = await import("./providers/discover.js");
      const { loadSourceCache, saveSourceCache } = await import("./session/source-cache.js");
      // Effective model sources: an explicit config allowlist wins; otherwise the auto-discovered set
      // (cached per omniroute). Empty = show all (until discovery fills it in).
      const manualSources = config.modelSources.length > 0;
      const sourcesRef = { current: manualSources ? config.modelSources : (loadSourceCache(home, config.baseUrl) ?? []) };
      const listModels = () => listOmniRouteModels({ baseUrl: config.baseUrl, apiKey: config.apiKey, sources: sourcesRef.current });
      const refreshSources = async (): Promise<string[]> => {
        const catalog = await fetchCatalog({ baseUrl: config.baseUrl, apiKey: config.apiKey });
        const found = await discoverSources({ catalog, probe: makeProbe({ baseUrl: config.baseUrl, apiKey: config.apiKey }) });
        sourcesRef.current = found;
        saveSourceCache(home, config.baseUrl, found);
        return found;
      };
      const sourcesInfo = () => ({ sources: sourcesRef.current, manual: manualSources, needsDiscovery: !manualSources && sourcesRef.current.length === 0 });
      // Strict health check for the model quarantine. makeProbe treats 429 as "routed" (the subscription
      // exists), which is right for source discovery but wrong here — a rate-limited model is precisely what
      // was quarantined. Only a real 200 releases it.
      const probeModel = async (model: string): Promise<boolean> => {
        try {
          const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/api/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
            body: JSON.stringify({ model, stream: false, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
            signal: AbortSignal.timeout(20_000),
          });
          return res.status === 200;
        } catch {
          return false;
        }
      };
      // /skills — what is loaded and which roles it reaches; update re-installs the repo-sourced ones.
      // What a role EFFECTIVELY uses, which is not the defaults table: a role that declares its own list
      // overrides it, and declaring an empty list opts out entirely. Reporting the defaults here would have
      // this command describe an assignment that never reaches an agent.
      const effectiveRoleSkills = (skill: string): string[] =>
        Object.keys(DEFAULT_ROLE_SKILLS)
          .concat(Object.keys(config.roles))
          .filter((r, i, a) => a.indexOf(r) === i)
          .filter((r) => (config.roles[r]?.skills ?? DEFAULT_ROLE_SKILLS[r] ?? []).includes(skill));
      const listSkills = () => skillRegistry.list().map((s) => ({
        ...s,
        roles: effectiveRoleSkills(s.name),
      }));
      // /skills add <github-url> — install it now, record it so it survives the session, load it in place.
      const addSkill = async (url: string): Promise<string> => {
        const src = parseSkillUrl(url);
        if (!src) return `Not a GitHub URL: \`${url}\`\n\n_Expected something like \`https://github.com/owner/repo\` or a link to the directory holding SKILL.md._`;
        const r = await installSkillSource(home, src);
        await saveSkillSource(home, src);
        await skillRegistry.loadFromDir(externalSkillsDir(home));
        const s = skillRegistry.get(src.name);
        const desc = s ? `\n\n> ${s.description}` : "";
        return `Installed **${src.name}** from \`${src.repo}\`${src.path ? `/${src.path}` : ""} at \`${r.sha.slice(0, 8)}\`.${desc}\n\n_Discoverable by every agent. \`/roles adjust\` assigns it to the roles it fits; \`/skills update\` re-installs it from upstream._`;
      };
      const updateSkills = async (): Promise<string> => {
        if (!config.skillSources.length) {
          return "No external skill sources configured. Add them under `skillSources` in your config.";
        }
        const { ok, failed } = await syncSkillSources(home, config.skillSources);
        await skillRegistry.loadFromDir(externalSkillsDir(home)); // pick up whatever changed, in place
        const changed = ok.filter((r) => r.changed);
        const lines = [
          ...changed.map((r) => `- ⬆️ **${r.name}** → \`${r.sha.slice(0, 8)}\``),
          ...ok.filter((r) => !r.changed).map((r) => `- ✓ ${r.name} already up to date`),
          ...failed.map((f) => `- ❌ **${f.name}** — ${f.error}`),
        ];
        const tail = changed.length ? "\n\n_Restart to pick up a changed skill in already-built prompts._" : "";
        return `**Skill sources:**\n${lines.join("\n")}${tail}`;
      };
      // /graph — the project's code graph. Reported with its FRESHNESS, because a stale graph that looks
      // authoritative is worse than none: an agent would trust callers that have since moved.
      const graphStatusText = async (): Promise<string> => {
        const st = await graphStatus(cwd);
        if (!st.built) {
          const py = await graphifyPython();
          return py
            ? "No code graph yet. `/graph build` — AST parsing only, no tokens, a few seconds.\n\n_Without it every agent works blind: it can grep for a name but cannot tell what calls it._"
            : "No code graph, and graphify is not installed.\n\n`uv tool install graphifyy` (or `pipx install graphifyy`), then `/graph build`.\n\n_MIT, pure tree-sitter AST parsing — no API key, no tokens._";
        }
        const age = st.builtAt ? `${Math.round((Date.now() - st.builtAt) / 60_000)} min ago` : "unknown";
        const fresh = st.stale
          ? `\n\n⚠️ **Stale** — changed since it was built: ${st.staleBecause.map((f) => `\`${f}\``).join(", ")}. Run \`/graph build\`.`
          : "\n\n✓ Up to date with the working tree.";
        // The brief cost tokens, so its freshness is reported with the same care as the graph's — a stale
        // brief is inherited by every trace written after it.
        const bs = await briefStatus(cwd, await traceableDocs());
        const briefLine = !bs.built
          ? "\n\n**Project brief:** not written — `/graph trace` writes it (this is the part that costs tokens)."
          : bs.stale
            ? `\n\n**Project brief:** ⚠️ stale — ${bs.changed.slice(0, 3).map((c) => `\`${c}\``).join(", ")}. \`/graph trace\` rewrites it.`
            : `\n\n**Project brief:** ✓ current, from ${bs.sources.length} document(s).`;
        return `**Project graph** — ${st.nodes} symbols, ${st.edges} relationships, built ${age}.${fresh}${briefLine}\n\n_Every agent can query it: \`graph_impact\` (blast radius), \`graph_trace\`, \`graph_find\`, \`graph_context\`, \`graph_overview\`._`;
      };
      const buildGraphText = async (): Promise<string> => (await buildProjectGraph(cwd)).message;
      /** Everything git tracks or would track — the pool the brief's documents are chosen from. */
      const traceableDocs = async (): Promise<string[]> =>
        (await defaultGitRunner(["ls-files", "--cached", "--others", "--exclude-standard"], cwd)).stdout.split("\n").filter(Boolean);
      // Which files are worth a trace: tracked or newly added source, never generated or vendored output.
      const traceableFiles = async (): Promise<string[]> => {
        const r = await defaultGitRunner(["ls-files", "--cached", "--others", "--exclude-standard"], cwd);
        return r.stdout.split("\n").filter(Boolean)
          .filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|h|cc|cpp|hpp|cs|php|swift|kt|scala)$/.test(f))
          .filter((f) => !/(^|\/)(dist|build|node_modules|vendor|\.horsecode|graphify-out)\//.test(f));
      };
      /**
       * The model that writes the traces.
       *
       * `tracer` is a role of its own so `/roles adjust` assigns it deliberately and `/roles setmodel tracer`
       * can override it. It needs a STRONG model: a trace is read by every agent that later touches the file,
       * so a shallow or invented note misleads all of them — and unlike a bad answer in a conversation, it is
       * written to disk and committed. Cheapness is the wrong axis here.
       *
       * Until the role has been assigned, it borrows from the strongest roles already configured rather than
       * falling back to the session default, which may be anything.
       */
      const tracerModel = (): string => {
        for (const role of ["tracer", "architect", "senior-coder", "judge"]) {
          const m = config.roles[role]?.models[0];
          if (m && m !== "default") return m;
        }
        return config.model;
      };
      const planTracesFn = async (): Promise<{ summary: string; jobs: number }> => {
        const plan = await planFor(cwd, await traceableFiles());
        return { summary: describePlan(plan, tracerModel()), jobs: plan.jobs.length };
      };
      const runTracesFn = async (): Promise<string> => {
        const files = await traceableFiles();
        // The brief first: a trace written without it describes mechanics, and rewriting them all later costs
        // the whole run again.
        const brief = await buildBrief({ cwd, provider, model: tracerModel(), files: await traceableDocs() });
        const plan = await planFor(cwd, files);
        const res = await runTraces({
          cwd, provider, model: tracerModel(), plan, liveFiles: new Set(files),
        });
        const bits = [`${brief.message}\n\n**Traces written: ${res.written}**`];
        if (res.upToDate) bits.push(`${res.upToDate} already current`);
        if (res.pruned.length) bits.push(`${res.pruned.length} removed for deleted files`);
        if (res.wroteGitignore) bits.push("\n\n_Added .gitignore rules: traces are committed, the AST cache is not._");
        if (res.failed.length) {
          bits.push(`\n\n⚠️ ${res.failed.length} failed:\n${res.failed.slice(0, 5).map((f) => `- \`${f.file}\` — ${f.error}`).join("\n")}`);
        }
        return `${bits.join(" · ")}\n\n_Committed with the repo, so every clone starts with them. Agents read one with \`graph_trace\`._`;
      };
      await runTuiRepl({
        buildDeps,
        memStore,
        listSkills,
        updateSkills,
        addSkill,
        graphStatus: graphStatusText,
        buildGraph: buildGraphText,
        planTraces: planTracesFn,
        runTraces: runTracesFn,
        jobBase: { fromBranch, maxRounds: args.rounds ?? 3, ...(args.revisionRounds !== undefined && { revisionRounds: args.revisionRounds }) },
        formatResult: renderResult,
        model: config.model,
        listModels,
        mcp: config.mcp,
        refreshSources,
        sourcesInfo,
        probeModel,
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
    const deps = await buildDeps(read);
    // Headless runs get memory too: rules already ride every prompt via buildJobDeps; facts/lessons are
    // retrieved per turn and reinforced when actually cited.
    deps.memory = () => memStore.all();
    deps.reinforceMemory = (id) => { void memStore.reinforce(id); };
    deps.rememberFact = (fact) => { void memStore.add(fact); };
    deps.recordInjection = (ids) => { void memStore.recordInjection(ids); };
    deps.learnMemory = async (text, kind, o) => (await memStore.add(text, kind, o)).ok;
    // Headless has no chat pane; memory telemetry goes to stdout so an unattended run is still auditable.
    deps.onMemory = (ev) => { const t = memoryNote(ev); if (t) console.log(t); };
    await memStore.runHygiene().catch(() => { /* maintenance is best-effort */ });
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
