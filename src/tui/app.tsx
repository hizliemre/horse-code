import React from "react";
import { render } from "ink";
import type { LineReader } from "../terminal.js";
import { makeAskUser } from "../terminal.js";
import { runJob } from "../engine/job.js";
import type { JobDeps, JobResult } from "../engine/job.js";
import { toSlug } from "../worktree/slug.js";
import { meterProvider } from "../providers/meter.js";
import { TuiController } from "./controller.js";
import { App } from "./components.js";

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
}

/** TUI REPL: task input → live job → report → loop. Ctrl+C exits; job errors are isolated. */
export async function runTuiRepl(opts: RunTuiReplOpts): Promise<void> {
  const controller = new TuiController();
  const read: LineReader = (q, opts) => controller.ask(q, opts);
  const deps0 = await opts.buildDeps(read);
  // Coach model → always shown under the input; refiner model → shown only in the "refining… (model)" line.
  const coachModel = deps0.roleRegistry.peekModel("coach") || opts.model;
  const refinerModel = deps0.roleRegistry.peekModel("refiner") || opts.model;
  // Meter every LLM call → per-turn tokens + active model surface in the metrics line under the input.
  // onActivity → the write/edit tools stream file activity into the live strip.
  const deps: JobDeps = { ...deps0, provider: meterProvider(deps0.provider, controller.onUsage), onActivity: controller.pushActivity };
  // /model picker → live-swap every role's model on the running session (no config write).
  const setModel = (m: string): void => deps0.roleRegistry.setModelOverride(m);
  // Fullscreen (Claude Code model): alt-screen buffer + synchronized output (DECSET 2026).
  // Ink rewrites the whole screen on every frame → normally flickers; wrapping each write with
  // 2026h…2026l makes the terminal apply the frame atomically → flicker goes away (on terminals
  // that support it; others ignore the escape). Inner-scroll is handled in components.tsx with a
  // manual line-window (bypasses an Ink overflow bug). On exit (including Ctrl+C) the alt-screen
  // is closed and stdout.write is restored to its original.
  const origWrite = process.stdout.write.bind(process.stdout);
  const patched = ((chunk: unknown, ...rest: unknown[]): boolean =>
    typeof chunk === "string"
      ? (origWrite as (c: string, ...r: unknown[]) => boolean)("\x1b[?2026h" + chunk + "\x1b[?2026l", ...rest)
      : (origWrite as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    process.stdout.write = origWrite;
    // first pop the kitty protocol, then close the alt-screen + restore the cursor.
    try { origWrite("\x1b[<u\x1b[?1049l\x1b[?25h"); } catch { /* swallow */ }
  };
  // alt-screen + kitty keyboard protocol (flag 1: disambiguate) → Shift+Enter arrives as a separate
  // sequence (\x1b[13;2u) (plain Enter is still \r, arrows are still legacy → Ink scroll isn't broken).
  // Terminals that don't support it ignore \x1b[>1u (harmless; those terminals need Alt+Enter or
  // key-mapping instead).
  // \x1b> = DECKPNM (numeric keypad): force the numpad to send characters, not application-mode SS3
  // sequences — otherwise numpad digits and `/` can't be typed. (InputLine also maps the SS3 forms as a
  // fallback for terminals that ignore this.)
  origWrite("\x1b[?1049h\x1b[H\x1b[>1u\x1b>");
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
    if ((controller.getState().mode ?? "running") === "input") return; // InputLine handles it
    const now = Date.now();
    if (now - lastCtrlC < 200) { restore(); process.exit(0); } // double-tap within 200ms → force quit
    lastCtrlC = now;
    jobAbort?.abort(); // cancel the running job → it throws → endRun → back to input
  };
  process.stdin.on("data", onCtrlC);
  // Call awaitTask BEFORE render → the first render is input-mode (Prompt + useInput active) → Ink holds stdin.
  let taskPromise = controller.awaitTask();
  const instance = render(
    <App controller={controller} fullscreen model={opts.model} coachModel={coachModel} refinerModel={refinerModel} listModels={opts.listModels} setModel={setModel}
      onExit={() => { restore(); process.exit(0); }} />,
  );
  try {
    for (;;) {
      const task = await taskPromise;
      // Conversation history: the transcript's last item is this prompt → exclude it (previous turns go to the coach).
      const history = controller.getState().transcript.slice(0, -1).map((m) => ({ role: m.role, content: m.text }));
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
        });
        controller.endRun(opts.formatResult(res), res.refinedPrompt);
      } catch (e) {
        controller.endRun(jobAbort.signal.aborted ? "cancelled" : `error: ${e instanceof Error ? e.message : String(e)}`);
      }
      taskPromise = controller.awaitTask(); // input-mode for the next task
    }
  } finally {
    instance.unmount();
    restore();
  }
}
