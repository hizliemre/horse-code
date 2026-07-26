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
import { basename } from "node:path";
import { TuiController } from "./controller.js";
import { App } from "./components.js";
import { REQUIRED_ROLES } from "../prompts.js";
import { SessionStore } from "../session/store.js";
import { PinStore } from "../session/pins.js";
import { MemoryStore } from "../session/memory.js";
import { ModelHealth } from "../engine/model-health.js";
import { saveRoleChains } from "../config/save-roles.js";
import { saveRoleSkills } from "../config/save-skills.js";
import { tuneRoleSkills } from "../engine/skill-tuner.js";
import { scanRepo } from "../engine/scan-repo.js";
import { graphStatus, buildProjectGraph } from "../engine/project-graph.js";
import { memoryState } from "../engine/memory-retrieval.js";
import { memoryNote } from "../engine/memory-inject.js";
import type { MemoryEntry } from "../engine/memory-retrieval.js";
import { TerminalTitle } from "./terminal-title.js";
import { phaseLabel } from "./labels.js";

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
  // Model health: a role whose whole chain dies gets a new one, and the dead models are quarantined across
  // EVERY registry so they stop being handed out — to this role or any other.
  const health = new ModelHealth({
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
      // The tuner keeps `architect` on a strong model, and this is a judgement task: a rule imported wrongly
      // is applied to every task from then on.
      model: deps0.roleRegistry.peekModel("architect") || opts.model || "",
      memStore: opts.memStore,
      ask: (q, o) => controller.ask(q, o),
      note: (t) => controller.note(t),
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
    // pop bracketed paste + the kitty protocol, then close the alt-screen + restore the cursor.
    try { origWrite("\x1b[?2004l\x1b[<u\x1b[?1049l\x1b[?25h"); } catch { /* swallow */ }
  };
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
    <App controller={controller} fullscreen model={opts.model} coachModel={coachModel} refinerModel={refinerModel} listModels={opts.listModels} setModel={setModel} setRoleModel={applyChainPersisted} listRoles={listRoles} adjustRoles={adjustRoles} listSkills={opts.listSkills} updateSkills={opts.updateSkills} addSkill={opts.addSkill} graphStatus={opts.graphStatus} buildGraph={opts.buildGraph} planTraces={opts.planTraces} runTraces={opts.runTraces} migrate={migrate}
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
