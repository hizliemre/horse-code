import React from "react";
import { render } from "ink";
import type { LineReader } from "../terminal.js";
import { makeAskUser } from "../terminal.js";
import { runJob } from "../engine/job.js";
import type { JobDeps, JobResult } from "../engine/job.js";
import { tuneRoleModels } from "../engine/role-tuner.js";
import { mostCapable, adjustRoleModels, ROLE_PROFILES } from "./role-models.js";
import { toSlug } from "../worktree/slug.js";
import { meterProvider } from "../providers/meter.js";
import { firewallProvider } from "../providers/firewall.js";
import { connectAllMcp, type McpBundle } from "../mcp/registry.js";
import type { McpServerSpec } from "../config/config.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { basename } from "node:path";
import { TuiController } from "./controller.js";
import { App } from "./components.js";
import { REQUIRED_ROLES } from "../prompts.js";
import { SessionStore } from "../session/store.js";
import { PinStore } from "../session/pins.js";
import { MemoryStore } from "../session/memory.js";
import { ModelHealth } from "../engine/model-health.js";
import { saveRoleChains } from "../config/save-roles.js";
import { saveMaxParallel } from "../config/save-parallel.js";
import { MAX_PARALLEL_TASKS } from "../engine/wave-engine.js";
import { saveRoleSkills } from "../config/save-skills.js";
import { tuneRoleSkills } from "../engine/skill-tuner.js";
import { scanRepo } from "../engine/scan-repo.js";
import { graphStatus, buildProjectGraph } from "../engine/project-graph.js";
import { memoryState } from "../engine/memory-retrieval.js";
import { memoryNote } from "../engine/memory-inject.js";
import type { MemoryEntry } from "../engine/memory-retrieval.js";
import { TerminalTitle } from "./terminal-title.js";
import { phaseLabel } from "./labels.js";
import { stripThinking } from "./format.js";
import { RoleFitness } from "../engine/role-fitness.js";
import { restoreTerminal, restoreOnExit } from "./restore-terminal.js";

export interface RunTuiOpts {
  buildDeps: (read: LineReader) => Promise<JobDeps>;
  job: { prompt: string; fromBranch: string; jobName: string; maxRounds: number; revisionRounds?: number; prTitle?: string };
}

/** Ink TUI: set up the controller → seams go through controller.ask → render App → runJob → unmount. */
export async function runTui(opts: RunTuiOpts): Promise<JobResult> {
  const controller = new TuiController();
  const read: LineReader = (q, opts) => controller.ask(q, opts);
  const deps = await opts.buildDeps(read);
  const instance = render(<App controller={controller} />);
  try {
    return await runJob(deps, {
      ...opts.job,
      askUser: makeAskUser(read),
      onEvent: controller.onEvent,
    });
  } finally {
    instance.unmount();
  }
}

export interface RunTuiReplOpts {
  buildDeps: (read: LineReader) => Promise<JobDeps>;
  jobBase: { fromBranch: string; maxRounds: number; revisionRounds?: number };
  formatResult: (res: JobResult) => string;
  model?: string; // configured default model → shown in the metrics line when a call reports no model
  listModels: () => Promise<string[]>; // omniroute model list for the /model picker
  mcp?: Record<string, McpServerSpec>; // MCP servers to connect at startup (tools → coach)
  refreshSources?: () => Promise<string[]>; // probe omniroute → your connected model sources (cached)
  sourcesInfo?: () => { sources: string[]; manual: boolean; needsDiscovery: boolean }; // current source allowlist
  listSkills?: () => { name: string; description: string; roles: string[] }[]; // /skills
  updateSkills?: () => Promise<string>; // /skills update → re-install externally-sourced skills
  addSkill?: (url: string) => Promise<string>; // /skills add <url> → install from a repo
  graphStatus?: () => Promise<string>; // /graph
  buildGraph?: () => Promise<string>; // /graph build
  migrate?: () => Promise<string>; // /migrate
  addMcp?: (input: string) => Promise<string>; // /mcp add <url|command>
  maxParallel?: number; // configured task parallelism → /parallel shows and changes it
  startupNote?: string; // one line shown once at start (e.g. where the telemetry log is)
  telemetryPath?: string; // this run's telemetry log → /monitor reads it
  planTraces?: () => Promise<{ summary: string; jobs: number }>; // /graph trace → the free estimate
  runTraces?: () => Promise<string>; // /graph trace, after consent
  probeModel?: (model: string) => Promise<boolean>; // strict health check → releases a recovered model from quarantine
  memStore?: MemoryStore; // shared memory store (rules are wired into every registry by buildJobDeps)
}

/** TUI REPL: task input → live job → report → loop. Ctrl+C exits; job errors are isolated. */
export async function runTuiRepl(opts: RunTuiReplOpts): Promise<void> {
  const controller = new TuiController();
  const read: LineReader = (q, opts) => controller.ask(q, opts);
  const deps0 = await opts.buildDeps(read);
  // Surface a chat note whenever a role falls back off an exhausted model (429/5xx).
  deps0.roleRegistry.setNotify((msg) => controller.note(msg));
  // Coach model → always shown under the input; refiner model → shown only in the "refining… (model)" line.
  // Getters (not snapshots): re-read on every render so the line reflects live /roles adjust · setmodel changes.
  const coachModel = (): string => deps0.roleRegistry.peekModel("coach") || opts.model || "";
  const refinerModel = (): string => deps0.roleRegistry.peekModel("refiner") || opts.model || "";
  // Every assignable role: the main roles + the review TEAM lenses + the review COUNCIL deciders (both live in
  // SEPARATE registries). Bootstrap and /roles adjust must cover all of these — else a member stays on "default".
  const REQ = REQUIRED_ROLES as readonly string[];
  // Review roles live in FOUR separate registries: one finder-lens set per stage (spec/plan/code) + the council.
  const stageOf = new Map<string, "spec" | "plan" | "code">();
  for (const s of ["spec", "plan", "code"] as const) for (const c of deps0.teams[s]) stageOf.set(c.name, s);
  const teamNames = [...stageOf.keys()];
  const councilNames = deps0.council.map((c) => c.name);
  const reviewNames = new Set([...teamNames, ...councilNames]);
  const tunableRoles = (): string[] => [...REQUIRED_ROLES, ...teamNames, ...councilNames];
  const regFor = (role: string) => {
    if (REQ.includes(role)) return deps0.roleRegistry;
    const s = stageOf.get(role);
    return s ? deps0.teamRegistries[s] : deps0.councilRegistry;
  };
  const peekRole = (role: string): string => regFor(role).peekModel(role);
  const applyChain = (role: string, chain: string[]): void => regFor(role).setRoleModel(role, chain);
  /**
   * Applies AND persists a chain. Only deliberate choices (`/roles adjust`, `/roles setmodel`) are written —
   * the first-run bootstrap heuristic is intentionally NOT, because it is a guess made to get the session
   * moving and freezing it to disk would outlive the reason for it.
   */
  const applyChainPersisted = (role: string, chain: string[]): void => {
    applyChain(role, chain);
    void saveRoleChains(homedir(), [{ role, models: chain }]);
  };
  // /roles → each role + its full model chain (primary + fallbacks). `council` flags review team/council members
  // so the UI can group them. `model` = chain head, reflects /model.
  const listRoles = (): { name: string; model: string; models: string[]; council?: boolean; decider?: boolean }[] =>
    tunableRoles().map((r) => {
      const chain = regFor(r).chain(r);
      return { name: r, model: chain[0] ?? "", models: chain, council: reviewNames.has(r), decider: councilNames.includes(r) };
    });
  /**
   * What each model has actually managed to do in each role, kept across sessions.
   *
   * Wired into every registry so a chain never offers a role a model that role has already proven unusable,
   * and into ModelHealth so the automatic re-assignment cannot hand it back.
   */
  const fitness = deps0.fitness ?? new RoleFitness(join(homedir(), ".horsecode", "model-fitness.json"));
  for (const r of [deps0.roleRegistry, deps0.teamRegistries.spec, deps0.teamRegistries.plan, deps0.teamRegistries.code, deps0.councilRegistry]) {
    r.setFitness(fitness);
  }

  // Model health: a role whose whole chain dies gets a new one, and the dead models are quarantined across
  // EVERY registry so they stop being handed out — to this role or any other.
  const health = new ModelHealth({
    fitness,
    port: {
      roles: tunableRoles,
      registries: () => [deps0.roleRegistry, deps0.teamRegistries.spec, deps0.teamRegistries.plan, deps0.teamRegistries.code, deps0.councilRegistry],
      registryFor: regFor,
    },
    listModels: opts.listModels,
    // STRICTER than source discovery, which counts 429 as "routed": a rate-limited model is exactly what was
    // quarantined, so only a real answer may release it.
    ...(opts.probeModel ? { probe: opts.probeModel } : {}),
    note: (m) => controller.note(m),
  });
  health.watch(); // any benched model → every role still holding it is re-assigned at once

  // Meter every LLM call → per-turn tokens + active model surface in the metrics line under the input.
  // onActivity → the write/edit tools stream file activity into the live strip.
  const deps: JobDeps = {
    ...deps0,
    provider: firewallProvider(meterProvider(deps0.provider, controller.onUsage)), // redact secrets from every outgoing prompt

    onActivity: controller.pushActivity,
    onLiveActivity: controller.setLiveActivity, // live "writing <file> · N chars" during long tool generations
    note: (t) => controller.note(t), // persistent chat-flow notes from deep in the pipeline (auto-commits)
    get maxParallel() { return parallelRef.current; }, // re-read per scheduling pass → /parallel is live

    inbox: () => controller.takeInboxNote(), // "by-the-way" notes → folded into the running coach turn
    pins: () => pinStore.list(), // context pins → coach system prompt
    memory: () => memStore.all(), // cross-session memory → retrieved + injected into relevant turns
    reinforceMemory: (id) => { void memStore.reinforce(id); }, // bump memories the coach actually cited
    mcpTools: () => mcpHolder.bundle?.tools ?? [], // MCP tools (filled once the servers connect)
    rememberFact: (fact) => { // remember_fact tool → persist a fact learned mid-turn (from a tool result)
      void memStore.add(fact).then((r) => { if (r.ok) controller.note(`🧠 **Remembered** — ${fact}${r.superseded.length ? ` _(replaced: ${r.superseded.join("; ")})_` : ""}`); });
    },
    recordInjection: (ids) => { void memStore.recordInjection(ids); }, // durable "shown N times" count → hygiene
    rechainRole: (role, reason) => health.handleChainFailure(role, reason), // dead chain → quarantine + reassign
    // Memory used to work invisibly, so "no memory applied" and "memory is broken" looked identical. Every
    // injection, citation and extraction now surfaces as one compact chat line.
    onMemory: (ev) => { const t = memoryNote(ev); if (t) controller.note(t); },
    learnMemory: async (text, kind, o) => (await memStore.add(text, kind, o)).ok, // post-job auto-extraction
    compactionState: {}, // holds the compaction summary cache across turns (invalidated on /clear or /resume by fingerprint)
  };
  // /model picker → live-swap every role's model on the running session (no config write).
  const setModel = (m: string): void => deps0.roleRegistry.setModelOverride(m);
  /**
   * Task parallelism, held in a ref so a change reaches the RUNNING job.
   *
   * `deps.maxParallel` is a getter over this, and the scheduler re-reads its ceiling on every pass — so
   * `/parallel 12` fills the extra slots as soon as tasks finish, instead of at the next job.
   */
  const parallelRef = { current: opts.maxParallel ?? MAX_PARALLEL_TASKS };
  const setParallel = (n: number): void => {
    parallelRef.current = n;
    void saveMaxParallel(homedir(), n);
  };
  /**
   * Answers a "by-the-way" question while work is still running.
   *
   * The inbox is read by the coach, which is not running during a coding phase — so a question asked then
   * waited for the whole job to finish. This answers it against the live state instead: the board, the
   * agents in flight, and the recent activity, which is what such a question is almost always about.
   *
   * Deliberately its own small call rather than an interruption: the running work is untouched, and a
   * failure here costs the answer, not the job.
   */
  const answerByTheWay = (question: string): void => {
    const model = deps0.roleRegistry.peekModel("coach") || opts.model || "";
    /**
     * The answer goes into the CHAT, like every other answer.
     *
     * It used to be pinned above the input so it could not scroll away. That panel drew raw text — no
     * markdown, and a model that emits its own `<think>` tags leaked them onto the screen — and it held one
     * answer, so asking a second question erased the first. In the transcript it renders like everything
     * else, it stays, and the newest is at the bottom where the eye already is.
     */
    const show = controller.liveNote();
    let raw = "";
    const append = (delta: string): void => { raw += delta; show(stripThinking(raw)); };
    void (async () => {
      try {
        const req = {
          model,
          messages: [
            { role: "system" as const, content:
              "You answer a short question about a coding job that is running right now. Answer ONLY from " +
              "the state given — it is all you can see. If the state does not contain the answer, say so " +
              "plainly and say what would. Be brief: two or three sentences, no preamble." },
            { role: "user" as const, content: `${controller.liveSnapshot()}\n\nQuestion: ${question}` },
          ],
          tools: [],
        };
        let any = false;
        for await (const ev of deps.provider.chat(req, new AbortController().signal)) {
          if (ev.type === "text-delta") { any = true; append(ev.text); }
          else if (ev.type === "error") throw new Error(ev.message);
        }
        if (!any) append("(no answer came back)");
      } catch (e) {
        append(`could not answer that right now — ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  };
  /**
   * `/mcp add` — install a server from the page that documents it, or from the command that page tells you
   * to run.
   *
   * Verified by starting it before anything is written. A config entry that does not work is worse than no
   * entry: it fails at startup, in a place the user is not looking, and every agent silently loses the tools
   * it was supposed to gain.
   */
  const addMcp = async (input: string): Promise<string> => {
    const { parseCommand, parseConfigBlock, extractFromPage, verify } = await import("../mcp/install.js");
    const { saveMcpServer } = await import("../config/save-skills.js");
    let cand = parseCommand(input) ?? parseConfigBlock(input);
    if (!cand) {
      const url = input.trim();
      if (!/^https?:\/\//i.test(url)) {
        return "Give a URL, a config block, or the command itself — e.g. `/mcp add https://angular.dev/ai/mcp` or `/mcp add npx -y @angular/cli mcp`.";
      }
      let html: string;
      try {
        const res = await fetch(url, { headers: { "User-Agent": "horse-code" }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) return `Could not read ${url} (HTTP ${res.status}).`;
        html = await res.text();
      } catch (e) {
        return `Could not read ${url} — ${e instanceof Error ? e.message : String(e)}`;
      }
      controller.note(`Read ${url}. Working out the server configuration…`);
      cand = await extractFromPage({
        provider: deps.provider,
        model: deps0.roleRegistry.peekModel("architect") || opts.model || "",
        url, html,
      });
      if (!cand) return `That page does not state an MCP server command I could read. Paste the command or the config block instead.`;
    }
    const shown = "command" in cand.spec ? `\`${cand.spec.command.join(" ")}\`` : `\`${cand.spec.url}\``;
    controller.note(`**${cand.name}** → ${shown}\n_from ${cand.source}_\n\nStarting it to check…`);
    const v = await verify(cand.spec, cand.name);
    if (!v.ok) {
      return `**${cand.name}** did not work: ${v.error}.\n\nNothing was written. The command was ${shown} — ` +
        `check it against the documentation, or pass it directly with \`/mcp add <command>\`.`;
    }
    // Read-only is the server's OWN claim, per tool. Guessing it would either withhold safe tools from every
    // agent or hand a mutating one to all of them.
    const ro = v.tools.filter((t) => t.readOnly).length;
    await saveMcpServer(homedir(), cand.name, cand.spec);
    const names = v.tools.slice(0, 8).map((t) => `\`${t.name}\``).join(", ");
    const more = v.tools.length > 8 ? ` +${v.tools.length - 8} more` : "";
    const reach = ro === v.tools.length
      ? "All of them are read-only, so every agent gets them."
      : ro
        ? `${ro} are marked read-only and reach every agent; the rest are exec-level and reach the coach.`
        : "None are marked read-only, so they reach the coach only. Add `\"readOnly\": true` to the server in " +
          "your config if you know it cannot mutate anything, and every agent will get them.";
    return `**${cand.name}** installed — ${v.tools.length} tool(s): ${names}${more}\n\n${reach}\n\n_Restart to connect it._`;
  };

  /**
   * `/migrate` — bring another tool's accumulated setup across.
   *
   * Driven from here because it needs the things only the REPL has: a provider, the shared memory store, and
   * a way to ask the user a question and wait for the answer.
   */
  const migrate = async (): Promise<string> => {
    if (!opts.memStore) return "Migration needs the memory store, which is not available in this session.";
    const { runMigration, describeResult } = await import("../migrate/run.js");
    const r = await runMigration({
      cwd: process.cwd(), home: homedir(), provider: deps.provider,
      /**
       * The architect's whole CHAIN, not just its head.
       *
       * The tuner keeps `architect` on a strong model, and this is a judgement task: a rule imported wrongly
       * is applied to every task from then on. But passing one id made migration the only path in horse-code
       * without fallbacks — and a run against a real project lost its entire import to a single exhausted
       * quota while two healthy fallbacks sat unused in the same chain.
       */
      models: [...deps0.roleRegistry.chain("architect"), opts.model].filter((m): m is string => !!m),
      memStore: opts.memStore,
      ask: (q, o) => controller.ask(q, o),
      note: (t) => controller.note(t),
      existingSkills: () => (opts.listSkills?.() ?? []).map((s) => s.name),
      /**
       * Newly migrated skills go to the roles that should carry them, using the same tuner `/roles adjust`
       * uses — including its project preconditions, so a design skill is not attached in a project with no
       * interface. Restricted to the new names: a migration must not silently re-decide assignments the
       * user already made.
       */
      assignSkills: async (names) => {
        const all = opts.listSkills?.() ?? [];
        const fresh = all.filter((s) => names.includes(s.name));
        if (!fresh.length) return "";
        const project = await scanRepo(process.cwd());
        const tuner = deps0.roleRegistry.peekModel("architect") || opts.model || "";
        const { assignments, withheld } = await tuneRoleSkills({
          provider: deps.provider, tuner, project, roles: tunableRoles(), roleProfiles: ROLE_PROFILES,
          skills: fresh.map((s) => ({ name: s.name, description: s.description })),
        });
        // Merge, never replace: the tuner is asked only about the new skills, so a role's existing list has
        // to be carried through or migrating one skill would unassign everything else.
        const merged: Record<string, string[]> = {};
        for (const [role, list] of Object.entries(assignments)) {
          if (!list.length) continue;
          const current = deps0.roleRegistry.skillsFor(role);
          merged[role] = [...new Set([...current, ...list])];
        }
        if (Object.keys(merged).length) await saveRoleSkills(homedir(), merged);
        const rows = Object.entries(merged).map(([r, l]) => `- \`${r}\` → ${l.map((x) => `**${x}**`).join(", ")}`);
        const held = withheld.length
          ? `\n\nWithheld: ${withheld.map((w) => `${w.skill} (${w.because})`).join("; ")}`
          : "";
        return rows.length
          ? `**Skills assigned:**\n${rows.join("\n")}${held}\n\n_Restart to pick them up in already-built prompts._`
          : `No role needs one permanently${held}`;
      },
    });
    return describeResult(r);
  };
  /**
   * Keeps the code graph in step with the code after a job changes files.
   *
   * A graph that silently goes stale is worse than no graph: an agent asking "what calls this" would get an
   * answer that was true an hour ago and trust it. The rebuild is incremental AST parsing behind a SHA256
   * cache — seconds, no tokens — which is what makes doing it automatically affordable.
   *
   * Only refreshes a graph that ALREADY exists. Building the first one is a deliberate act, not something a
   * job should decide to spend the user's time on.
   */
  const refreshGraphIfStale = async (): Promise<void> => {
    try {
      const before = await graphStatus(process.cwd());
      if (!before.built || !before.stale) return;
      const r = await buildProjectGraph(process.cwd());
      if (r.ok) controller.note(`🔄 Code graph refreshed — ${r.nodes} symbols, ${r.edges} relationships.`);
    } catch { /* the graph is an aid, never a reason to fail a finished job */ }
  };
  /**
   * Second half of `/roles adjust`: which SKILLS each role should carry, for THIS project.
   *
   * Runs after the model chains and never blocks them — a role with the right model and a stale skill list is
   * far better than a failed adjust. The repository is scanned first so the assignment rests on facts rather
   * than on the tuner's impression of what the project is.
   */
  const adjustSkills = async (roleNames: string[], tuner: string): Promise<void> => {
    const skills = opts.listSkills?.() ?? [];
    if (!skills.length) return;
    const project = await scanRepo(process.cwd());
    controller.note(`🔎 **Project scan** — skills are assigned from this, not from a guess:\n${project.summary.split("\n").map((l) => `- ${l}`).join("\n")}`);
    const append = controller.streamNote("");
    controller.startBusy("assigning skills", tuner);
    try {
      const { assignments, withheld, reasoning } = await tuneRoleSkills({
        provider: deps.provider, tuner, skills, roles: roleNames, roleProfiles: ROLE_PROFILES, project,
        onReason: append,
      });
      controller.endBusy();
      if (!Object.keys(assignments).length) { controller.note(reasoning); return; }
      const saved = await saveRoleSkills(homedir(), assignments);
      const given = Object.entries(assignments).filter(([, s]) => s.length);
      const rows = given.length
        ? given.map(([role, s]) => `- \`${role}\` → ${s.map((x) => `**${x}**`).join(", ")}`).join("\n")
        : "- (none — no skill fits this project)";
      // Withheld assignments are reported, never silently dropped: a skill that vanished without a reason
      // reads as a bug, and the reason is the whole value of scanning the repo.
      const held = withheld.length
        ? `\n\n**Withheld:**\n${withheld.map((w) => `- \`${w.role}\` ✗ ${w.skill} — ${w.because}`).join("\n")}`
        : "";
      const rest = skills.map((s) => s.name).filter((n) => !given.some(([, list]) => list.includes(n)));
      const disc = rest.length ? `\n\n_Still discoverable on demand by every agent: ${rest.map((n) => `\`${n}\``).join(", ")}._` : "";
      controller.note(`**Skills assigned:**\n${rows}${held}${disc}\n\n_${saved ? "Saved to your config. " : ""}Override any role with \`"skills": []\` in your config to opt it out._`);
    } catch (e) {
      controller.endBusy();
      controller.note(`Skill assignment error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  // /roles adjust → a capable model reasons through role→model assignments (rationale shown in chat), then
  // the validated 3-model chains are applied to every role. Falls back to the heuristic on any failure.
  const adjustRoles = async (): Promise<void> => {
    if (!opts.listModels) { controller.note("Role adjust is not available."); return; }
    // A quota limit is temporary: re-probe what is quarantined FIRST so models whose window reset come back
    // into the pool, then assign from healthy models only — a spent model must never be handed out again.
    await health.refresh();
    let models: string[];
    try { models = await health.healthyModels(); }
    catch (e) { controller.note(`Adjust error: ${e instanceof Error ? e.message : String(e)}`); return; }
    const held = health.quarantined();
    if (held.length) controller.note(`⛔ Excluding ${held.length} quarantined model(s): ${held.map((q) => q.model).join(", ")}`);
    if (!models.length) { controller.note("No healthy models available to assign."); return; }
    const roleNames = tunableRoles(); // main roles + review councilors (both must be covered)
    const tuner = mostCapable(models);
    controller.note(`🤖 \`${tuner}\` is assigning models to all ${roleNames.length} roles — reasoning over cost, capability & source diversity:`);
    const append = controller.streamNote(""); // reasoning streams here live
    controller.startBusy("tuning", tuner); // status line: shimmer + live timer + token spend
    try {
      const { chains } = await tuneRoleModels({ provider: deps.provider, models, roles: roleNames, onReason: append });
      for (const { role, models: ch } of chains) applyChain(role, ch);
      controller.endBusy();
      const saved = await saveRoleChains(homedir(), chains);
      const rows = chains.map(({ role, models: ch }) => `- \`${role}\` → ${ch[0] ?? "—"}${ch.slice(1).map((m) => `  ↳ ${m}`).join("")}`);
      controller.note(`**Roles adjusted** (LLM-tuned · primary + 2 fallbacks · falls back on exhaustion):\n${rows.join("\n")}\n\n_${saved ? `Saved to your config — future sessions start with these. ` : ""}\`/roles setmodel\` to fine-tune any chain._`);
      await adjustSkills(roleNames, tuner);
      return;
    } catch (e) {
      controller.endBusy();
      controller.note(`Adjust error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  // On a clean config every role (main + councilors) resolves to the "default" placeholder → every call fails.
  const rolesUnconfigured = (): boolean =>
    tunableRoles().every((r) => { const m = peekRole(r); return !m || m === "default"; });
  // First-run bootstrap: once sources are known, if no real models are set, apply the FAST heuristic chains
  // (session-only, config untouched) so the app works immediately. The user can `/roles adjust` to tune with reasoning.
  const bootstrapRoles = async (): Promise<void> => {
    if (!rolesUnconfigured()) return; // real role models already configured/assigned → leave them
    let models: string[];
    try { models = await opts.listModels(); } catch { return; }
    if (!models.length) return;
    const adj = adjustRoleModels(tunableRoles(), models);
    if (!adj.length) return;
    for (const { role, models: ch } of adj) applyChain(role, ch);
    controller.note("Bootstrapped role models from your sources — run `/roles adjust` to tune them with an LLM.");
  };
  // Session persistence (per project) → the transcript is saved after every turn so a session can be resumed.
  const store = new SessionStore({ home: homedir(), cwd: process.cwd() });
  const listSessions = (): Promise<{ id: string; title: string; updatedAt: number; count: number }[]> =>
    store.list().then((ss) => ss.filter((s) => s.id !== store.id)); // exclude the session we're writing to
  const resumeSession = async (id: string): Promise<{ messages: { role: "user" | "assistant"; text: string }[] } | undefined> => {
    const d = await store.load(id);
    if (d) store.setActive(id); // continue that session → later saves overwrite it, not fork
    return d;
  };
  // Context pins (per project) → injected into the coach's system prompt every turn.
  const pinStore = new PinStore({ home: homedir(), cwd: process.cwd() });
  await pinStore.load(); // populate the sync list() before the first request
  const listPins = (): string[] => pinStore.list();
  const addPin = (text: string): Promise<{ ok: true; pin: string } | { ok: false; error: string }> => pinStore.add(text);
  const removePin = (n: number): Promise<string | undefined> => pinStore.remove(n);
  // Cross-session memory (per project) → relevant facts retrieved + injected into the coach turn.
  // The store is created at the composition root (cli.ts) so every entry point shares ONE memory and the
  // rules are already wired into every registry there; fall back to a local one only for direct callers/tests.
  const memStore = opts.memStore ?? new MemoryStore({ home: homedir(), cwd: process.cwd() });
  await memStore.load();
  // Durable rules (kind "rule") apply to EVERY role — appended to each role's system prompt (spec-kit phases,
  // council, coach, implementers…), so e.g. "respond in Turkish" holds through the whole pipeline, not just chat.
  const rulesFromMemory = (): string[] => memStore.all().filter((m) => m.kind === "rule").map((m) => m.text);
  // NB: rules are bound to every registry in buildJobDeps (composition root) so ALL entry points get them —
  // re-binding here is only needed when a caller built deps without a `rules` source (tests/direct use).
  if (!opts.memStore) {
    deps0.roleRegistry.setRules(rulesFromMemory);
    for (const s of ["spec", "plan", "code"] as const) deps0.teamRegistries[s].setRules(rulesFromMemory);
    deps0.councilRegistry.setRules(rulesFromMemory);
  }
  // Surface any rules carried over from previous sessions on launch, so the user knows what's in effect
  // even when they don't (re)state them this session.
  const carried = rulesFromMemory();
  if (carried.length) controller.note(`📌 **Active rules** (${carried.length}): ${carried.join(" · ")}`);
  // One maintenance pass per session: near-duplicates that arrived from different angles are merged, and
  // entries that stopped earning their place are flagged (never deleted — the file is the only copy).
  void memStore.runHygiene().then((r) => {
    const t = memoryNote({ kind: "hygiene", merged: r.merged.reduce((n, m) => n + m.absorbed.length, 0), candidates: r.candidates.length });
    if (t) controller.note(t);
  }).catch(() => { /* maintenance is best-effort; never blocks a session */ });
  // /memory shows the lifecycle state so a memory that stopped being injected is visible, not silently gone.
  const listMemories = (): (MemoryEntry & { state: string })[] => {
    const all = memStore.all();
    const now = Date.now();
    const flagged = new Set(memStore.reviewCandidates());
    return all.map((m) => ({ ...m, state: flagged.has(m.id) ? "review" : memoryState(m, all, now) }));
  };
  const addMemory = (text: string): Promise<{ ok: true; entry: MemoryEntry; superseded: string[] } | { ok: false; error: string }> => memStore.add(text);
  const removeMemory = (n: number): Promise<string | undefined> => memStore.remove(n);
  // MCP servers → connect in the background; tools reach the coach once connected (a note reports status).
  const mcpHolder: { bundle?: McpBundle } = {};
  if (opts.mcp && Object.keys(opts.mcp).length) {
    void connectAllMcp(opts.mcp).then((b) => {
      mcpHolder.bundle = b;
      const ok = b.status.filter((s) => s.ok);
      if (ok.length) controller.note(`MCP connected: ${ok.map((s) => `${s.name} (${s.toolCount} tools)`).join(", ")}`);
      if (opts.startupNote) controller.note(opts.startupNote);
      for (const f of b.status.filter((s) => !s.ok)) controller.note(`MCP ${f.name} failed: ${f.error}`);
    }, (e) => controller.note(`MCP connect error: ${e instanceof Error ? e.message : String(e)}`));
  }
  const listMcp = (): { name: string; ok: boolean; toolCount: number; error?: string }[] => mcpHolder.bundle?.status ?? [];
  // First run (no explicit config allowlist, no cache) → auto-discover the user's connected model sources
  // in the background so /model, /roles setmodel, and /roles adjust only offer their real subscriptions.
  if (opts.sourcesInfo && opts.refreshSources && opts.sourcesInfo().needsDiscovery) {
    controller.note("Discovering your connected model sources (probing omniroute)…");
    void opts.refreshSources().then(
      (found) => { controller.note(found.length ? `Model sources: ${found.join(", ")} (cached).` : "No connected sources found — showing all models."); void bootstrapRoles(); },
      (e) => { controller.note(`Source discovery failed: ${e instanceof Error ? e.message : String(e)}`); void bootstrapRoles(); }, // still bootstrap (shows all models)
    );
  } else {
    void bootstrapRoles(); // sources already cached/manual → bootstrap role models now
  }
  // Fullscreen (Claude Code model): alt-screen buffer + synchronized output (DECSET 2026).
  // Ink rewrites the whole screen on every frame → normally flickers; wrapping each write with
  // 2026h…2026l makes the terminal apply the frame atomically → flicker goes away (on terminals
  // that support it; others ignore the escape). Inner-scroll is handled in components.tsx with a
  // manual line-window (bypasses an Ink overflow bug). On exit (including Ctrl+C) the alt-screen
  // is closed and stdout.write is restored to its original.
  const origWrite = process.stdout.write.bind(process.stdout);
  // Terminal tab/window title (OSC-0): spinner + active phase while a job runs, project name when idle.
  const title = new TerminalTitle((s) => { origWrite(s); }, {
    idle: `horse-code — ${basename(process.cwd())}`,
    enabled: process.env.HORSECODE_NO_TITLE !== "1",
  });
  controller.subscribe(() => {
    const st = controller.getState();
    if (st.meta?.running) title.working(phaseLabel(st.phase).replace(/…$/, "") || "working"); // strip ellipsis; the spinner implies activity
    else title.idle();
  });
  const patched = ((chunk: unknown, ...rest: unknown[]): boolean =>
    typeof chunk === "string"
      ? (origWrite as (c: string, ...r: unknown[]) => boolean)("\x1b[?2026h" + chunk + "\x1b[?2026l", ...rest)
      : (origWrite as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    title.stop(); // stop the spinner, reset the tab title
    void mcpHolder.bundle?.closeAll(); // shut down MCP servers
    process.stdout.write = origWrite;
    /**
     * Raw mode too — not only the display modes.
     *
     * `process.exit()` does not unmount Ink, so Ink's own `setRawMode(false)` never runs on the paths that
     * call it. Reported after a real session: quitting left the shell echoing `^M` for Enter and `^C` for
     * interrupt, with commands typed as `clear^M^C^C^C…` and never executed.
     */
    restoreTerminal({ stdin: process.stdin, write: (x) => origWrite(x) });
    unhook();
  };
  /**
   * …and on every way out, including the ones this code does not control.
   *
   * A signal that reaches the process runs no `exit` handler by default, so a `kill` or a Ctrl+C that gets
   * past the TUI would leave the terminal raw. Registered here rather than at each `process.exit` call site
   * so a new exit path cannot forget it.
   */
  const unhook = restoreOnExit({ stdin: process.stdin, write: (x) => origWrite(x) });
  // alt-screen + kitty keyboard protocol (flag 1: disambiguate) → Shift+Enter arrives as a separate
  // sequence (\x1b[13;2u) (plain Enter is still \r, arrows are still legacy → Ink scroll isn't broken).
  // Terminals that don't support it ignore \x1b[>1u (harmless; those terminals need Alt+Enter or
  // key-mapping instead).
  // \x1b> = DECKPNM (numeric keypad): force the numpad to send characters, not application-mode SS3
  // sequences — otherwise numpad digits and `/` can't be typed. (InputLine also maps the SS3 forms as a
  // fallback for terminals that ignore this.)
  // …plus \x1b[?2004h = bracketed paste: the terminal wraps pastes in \x1b[200~ … \x1b[201~ so the input
  // can insert them as one literal block (newlines preserved, no accidental submit).
  origWrite("\x1b[?1049h\x1b[H\x1b[>1u\x1b>\x1b[?2004h");
  process.stdout.write = patched;
  process.once("exit", restore);
  // Per-job AbortController → Ctrl+C cancels the running job (aborts the in-flight request); a second
  // Ctrl+C within 200ms force-quits. In input mode InputLine handles Ctrl+C (clear if non-empty / exit if empty).
  let jobAbort: AbortController | undefined;
  let lastCtrlC = 0;
  // Under the kitty protocol, Ctrl+C no longer arrives as \x03 but as \x1b[99;5u → Ink's exitOnCtrlC can't see it.
  const onCtrlC = (chunk: Buffer | string): void => {
    const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (s !== "\x03" && s !== "\x1b[99;5u") return;
    // Double-tap → force quit, from ANY state. This is the ALWAYS-available escape hatch: it runs BEFORE the
    // per-mode defer below, so even a state whose single-press handler is stuck (a panel, a blocked prompt)
    // can never trap the user — a quick second Ctrl+C always quits (matches the "press twice to quit" hint).
    const now = Date.now();
    if (now - lastCtrlC < 400) { restore(); process.exit(0); }
    lastCtrlC = now;
    const st = controller.getState();
    const mode = st.mode ?? "running";
    // Single press: a cancellable panel (model picker, choice selector) owns Ctrl+C → it cancels like Esc.
    // Input mode: InputLine handles it (clear if non-empty / exit if empty).
    if (mode === "input" || mode === "picker" || st.pending?.options?.length) return;
    jobAbort?.abort(); // cancel the running job → it throws → endRun → back to input
  };
  process.stdin.on("data", onCtrlC);
  // Call awaitTask BEFORE render → the first render is input-mode (Prompt + useInput active) → Ink holds stdin.
  let taskPromise = controller.awaitTask();
  const instance = render(
    <App controller={controller} fullscreen model={opts.model} coachModel={coachModel} refinerModel={refinerModel} listModels={opts.listModels} setModel={setModel} setRoleModel={applyChainPersisted} listRoles={listRoles} adjustRoles={adjustRoles} listSkills={opts.listSkills} updateSkills={opts.updateSkills} addSkill={opts.addSkill} graphStatus={opts.graphStatus} buildGraph={opts.buildGraph} planTraces={opts.planTraces} runTraces={opts.runTraces} migrate={migrate} addMcp={addMcp} answerByTheWay={answerByTheWay} parallel={() => parallelRef.current} setParallel={setParallel} telemetryPath={opts.telemetryPath}
      listSessions={listSessions} resumeSession={resumeSession}
      listPins={listPins} addPin={addPin} removePin={removePin}
      listMemories={listMemories} addMemory={addMemory} removeMemory={removeMemory}
      listMcp={listMcp}
      sourcesInfo={opts.sourcesInfo} refreshSources={opts.refreshSources}
      permMode={() => deps0.permission.mode} setPermMode={(m) => deps0.permission.setMode(m)}
      cancelJob={() => jobAbort?.abort()}
      onExit={() => { restore(); process.exit(0); }} />,
  );
  try {
    for (;;) {
      const task = await taskPromise;
      // Conversation history: the transcript's last item is this prompt → exclude it (previous turns go to
      // the coach). Inline tool-activity items carry no message → filter them out of the history.
      const history = controller.getState().transcript.slice(0, -1)
        .filter((m): m is { role: "user" | "assistant"; text: string } => !("kind" in m))
        .map((m) => ({ role: m.role, content: m.text }));
      const images = controller.takeAttachments(); // images pasted (Alt+V) before this submit
      controller.beginRun();
      // Fresh abort controller per job → Ctrl+C aborts THIS job's signal; the next job gets a clean one.
      jobAbort = new AbortController();
      deps.signal = jobAbort.signal;
      try {
        const res = await runJob(deps, {
          ...opts.jobBase,
          prompt: task,
          jobName: toSlug(task) || "hcode-job",
          askUser: makeAskUser(read),
          onEvent: controller.onEvent,
          history,
          images: images.length ? images : undefined,
        });
        controller.endRun(opts.formatResult(res), res.refinedPrompt);
        void refreshGraphIfStale();
        if (res.kind === "chat") {
          if (res.nextSteps?.length) controller.setNextSteps(res.nextSteps); // coach follow-ups → /next
          const sup = (s: string[]) => (s.length ? ` _(replaced: ${s.join("; ")})_` : "");
          const dup = (r: { ok: false; error: string }) => r.error === "already remembered"; // already in memory
          // Auto-rules: durable behavioral directives the coach flagged (<rule>) → always-honored memory.
          for (const rule of res.rules ?? []) {
            void memStore.add(rule, "rule").then((r) => {
              if (r.ok) controller.note(`📌 **Rule saved** — ${rule}${sup(r.superseded)}`);
              else if (dup(r)) controller.note(`📌 **Rule already active** — ${rule}`); // re-stated an existing rule
            });
          }
          // Auto-remember: durable facts the coach flagged (<remember>) → memory store (deduped), with feedback.
          for (const fact of res.remembered ?? []) {
            void memStore.add(fact).then((r) => {
              if (r.ok) controller.note(`🧠 **Remembered** — ${fact}${sup(r.superseded)}`);
              else if (dup(r)) controller.note(`🧠 **Already known** — ${fact}`);
            });
          }
          // Auto-lessons: learnings the coach flagged from a correction/failure → memory (kind "lesson").
          for (const lesson of res.lessons ?? []) {
            void memStore.add(lesson, "lesson").then((r) => { if (r.ok) controller.note(`📖 **Lesson learned** — ${lesson}${sup(r.superseded)}`); });
          }
        }
      } catch (e) {
        const msg = jobAbort.signal.aborted ? "cancelled" : `error: ${e instanceof Error ? e.message : String(e)}`;
        jobAbort.abort(); // stop any in-flight parallel work (e.g. sibling councilors) so it can't keep spending after "done"
        controller.endRun(msg);
      }
      // Persist the conversation after every turn → the session can be resumed later (best-effort).
      void store.save(controller.messages()).catch(() => { /* persistence is non-fatal */ });
      // Any "by-the-way" notes the turn never consumed (e.g. a short chat or a non-coach turn) → run them next.
      for (const note of controller.drainInbox()) controller.submitTask(note);
      taskPromise = controller.awaitTask(); // input-mode for the next task
    }
  } finally {
    instance.unmount();
    restore();
  }
}
