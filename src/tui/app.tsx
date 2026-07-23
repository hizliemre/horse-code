import React from "react";
import { render } from "ink";
import type { LineReader } from "../terminal.js";
import { makeAskUser } from "../terminal.js";
import { runJob } from "../engine/job.js";
import type { JobDeps, JobResult } from "../engine/job.js";
import { tuneRoleModels } from "../engine/role-tuner.js";
import { mostCapable, adjustRoleModels } from "./role-models.js";
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
  // Every assignable role: the main roles + the review councilors (which live in a SEPARATE registry). Both
  // bootstrap and /roles adjust must cover all of these — otherwise a councilor stays on the invalid "default".
  const REQ = REQUIRED_ROLES as readonly string[];
  const councilorNames = deps0.councilors.map((c) => c.name);
  const tunableRoles = (): string[] => [...REQUIRED_ROLES, ...councilorNames];
  const regFor = (role: string) => (REQ.includes(role) ? deps0.roleRegistry : deps0.councilRegistry);
  const peekRole = (role: string): string => regFor(role).peekModel(role);
  const applyChain = (role: string, chain: string[]): void => regFor(role).setRoleModel(role, chain);
  // /roles → each role + its full model chain (primary + fallbacks). `council` flags review councilors so the
  // UI can group them. `model` = chain head, reflects /model.
  const listRoles = (): { name: string; model: string; models: string[]; council?: boolean }[] =>
    tunableRoles().map((r) => {
      const chain = regFor(r).chain(r);
      return { name: r, model: chain[0] ?? "", models: chain, council: !REQ.includes(r) };
    });
  // Meter every LLM call → per-turn tokens + active model surface in the metrics line under the input.
  // onActivity → the write/edit tools stream file activity into the live strip.
  const deps: JobDeps = {
    ...deps0,
    provider: firewallProvider(meterProvider(deps0.provider, controller.onUsage)), // redact secrets from every outgoing prompt

    onActivity: controller.pushActivity,
    onLiveActivity: controller.setLiveActivity, // live "writing <file> · N chars" during long tool generations

    inbox: () => controller.takeInboxNote(), // "by-the-way" notes → folded into the running coach turn
    pins: () => pinStore.list(), // context pins → coach system prompt
    memory: () => memStore.all(), // cross-session memory → retrieved + injected into relevant turns
    reinforceMemory: (id) => { void memStore.reinforce(id); }, // bump memories the coach actually cited
    mcpTools: () => mcpHolder.bundle?.tools ?? [], // MCP tools (filled once the servers connect)
    rememberFact: (fact) => { // remember_fact tool → persist a fact learned mid-turn (from a tool result)
      void memStore.add(fact).then((r) => { if (r.ok) controller.note(`🧠 **Remembered** — ${fact}${r.superseded.length ? ` _(replaced: ${r.superseded.join("; ")})_` : ""}`); });
    },
    compactionState: {}, // holds the compaction summary cache across turns (invalidated on /clear or /resume by fingerprint)
  };
  // /model picker → live-swap every role's model on the running session (no config write).
  const setModel = (m: string): void => deps0.roleRegistry.setModelOverride(m);
  // /roles adjust → a capable model reasons through role→model assignments (rationale shown in chat), then
  // the validated 3-model chains are applied to every role. Falls back to the heuristic on any failure.
  const adjustRoles = async (): Promise<void> => {
    if (!opts.listModels) { controller.note("Role adjust is not available."); return; }
    let models: string[];
    try { models = await opts.listModels(); }
    catch (e) { controller.note(`Adjust error: ${e instanceof Error ? e.message : String(e)}`); return; }
    if (!models.length) { controller.note("No models available to assign."); return; }
    const roleNames = tunableRoles(); // main roles + review councilors (both must be covered)
    const tuner = mostCapable(models);
    controller.note(`🤖 \`${tuner}\` is assigning models to all ${roleNames.length} roles — reasoning over cost, capability & source diversity:`);
    const append = controller.streamNote(""); // reasoning streams here live
    controller.startBusy("tuning", tuner); // status line: shimmer + live timer + token spend
    try {
      const { chains } = await tuneRoleModels({ provider: deps.provider, models, roles: roleNames, onReason: append });
      for (const { role, models: ch } of chains) applyChain(role, ch);
      controller.endBusy();
      const rows = chains.map(({ role, models: ch }) => `- \`${role}\` → ${ch[0] ?? "—"}${ch.slice(1).map((m) => `  ↳ ${m}`).join("")}`);
      controller.note(`**Roles adjusted** (LLM-tuned · primary + 2 fallbacks · falls back on exhaustion):\n${rows.join("\n")}\n\n_\`/roles setmodel\` to fine-tune any chain._`);
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
  const memStore = new MemoryStore({ home: homedir(), cwd: process.cwd() });
  await memStore.load();
  // Durable rules (kind "rule") apply to EVERY role — appended to each role's system prompt (spec-kit phases,
  // council, coach, implementers…), so e.g. "respond in Turkish" holds through the whole pipeline, not just chat.
  const rulesFromMemory = (): string[] => memStore.all().filter((m) => m.kind === "rule").map((m) => m.text);
  deps0.roleRegistry.setRules(rulesFromMemory);
  deps0.councilRegistry.setRules(rulesFromMemory);
  // Surface any rules carried over from previous sessions on launch, so the user knows what's in effect
  // even when they don't (re)state them this session.
  const carried = rulesFromMemory();
  if (carried.length) controller.note(`📌 **Active rules** (${carried.length}): ${carried.join(" · ")}`);
  const listMemories = (): MemoryEntry[] => memStore.all();
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
    const st = controller.getState();
    const mode = st.mode ?? "running";
    // A cancellable panel (model picker, choice selector) owns Ctrl+C → it cancels like Esc, never quits.
    // Input mode: InputLine handles Ctrl+C (clear/exit).
    if (mode === "input" || mode === "picker" || st.pending?.options?.length) return;
    const now = Date.now();
    if (now - lastCtrlC < 200) { restore(); process.exit(0); } // double-tap within 200ms → force quit
    lastCtrlC = now;
    jobAbort?.abort(); // cancel the running job → it throws → endRun → back to input
  };
  process.stdin.on("data", onCtrlC);
  // Call awaitTask BEFORE render → the first render is input-mode (Prompt + useInput active) → Ink holds stdin.
  let taskPromise = controller.awaitTask();
  const instance = render(
    <App controller={controller} fullscreen model={opts.model} coachModel={coachModel} refinerModel={refinerModel} listModels={opts.listModels} setModel={setModel} setRoleModel={applyChain} listRoles={listRoles} adjustRoles={adjustRoles}
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
