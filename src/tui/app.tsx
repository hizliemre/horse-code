import React from "react";
import { render } from "ink";
import type { LineReader } from "../terminal.js";
import { makeAskUser } from "../terminal.js";
import { runJob } from "../engine/job.js";
import type { JobDeps, JobResult } from "../engine/job.js";
import { toSlug } from "../worktree/slug.js";
import { TuiController } from "./controller.js";
import { App } from "./components.js";

export interface RunTuiOpts {
  buildDeps: (read: LineReader) => JobDeps;
  job: { prompt: string; fromBranch: string; jobName: string; maxRounds: number; revisionRounds?: number; prTitle?: string };
}

/** Ink TUI: controller kur → seam'ler controller.ask üzerinden → App render → runJob → unmount. */
export async function runTui(opts: RunTuiOpts): Promise<JobResult> {
  const controller = new TuiController();
  const read: LineReader = (q) => controller.ask(q);
  const deps = opts.buildDeps(read);
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
  buildDeps: (read: LineReader) => JobDeps;
  jobBase: { fromBranch: string; maxRounds: number; revisionRounds?: number };
  formatResult: (res: JobResult) => string;
}

/** TUI REPL: görev-input → canlı job → rapor → döngü. Ctrl+C çıkar; job hatası izole edilir. */
export async function runTuiRepl(opts: RunTuiReplOpts): Promise<void> {
  const controller = new TuiController();
  const read: LineReader = (q) => controller.ask(q);
  const deps = opts.buildDeps(read);
  // Fullscreen (Claude Code modeli): alt-screen buffer + synchronized output (DECSET 2026).
  // Ink her frame'de tüm ekranı yeniden yazar → normalde flicker; her yazımı 2026h…2026l ile sararak
  // terminal frame'i atomik uygular → flicker gider (destekleyen terminallerde; diğerleri escape'i yok
  // sayar). İç-scroll ise components.tsx'te manuel satır-pencere ile (Ink overflow bug'ı baypas).
  // Çıkışta (Ctrl+C dahil) alt-screen kapatılır + stdout.write eski haline döner.
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
    // önce kitty protokolü pop, sonra alt-screen kapat + imleç geri.
    try { origWrite("\x1b[<u\x1b[?1049l\x1b[?25h"); } catch { /* yut */ }
  };
  // alt-screen + kitty keyboard protokolü (flag 1: disambiguate) → Shift+Enter ayrı dizi (\x1b[13;2u)
  // olarak gelir (düz Enter yine \r, oklar yine legacy → Ink scroll bozulmaz). Desteklemeyen terminaller
  // \x1b[>1u'yu yok sayar (zararsız; o terminallerde Alt+Enter veya key-mapping gerekir).
  origWrite("\x1b[?1049h\x1b[H\x1b[>1u");
  process.stdout.write = patched;
  process.once("exit", restore);
  // Kitty protokolünde Ctrl+C artık \x03 değil \x1b[99;5u olarak gelir → Ink exitOnCtrlC göremez.
  // Input mode'da InputLine yönetir (doluysa temizle / boşsa çık); job çalışırken global handler çıkar.
  const onCtrlC = (chunk: Buffer | string): void => {
    const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (s !== "\x03" && s !== "\x1b[99;5u") return;
    if ((controller.getState().mode ?? "running") === "input") return; // InputLine handle eder
    restore();
    process.exit(0);
  };
  process.stdin.on("data", onCtrlC);
  // awaitTask'i render'dan ÖNCE çağır → ilk render input-mode (Prompt + useInput aktif) → Ink stdin'i tutar.
  let taskPromise = controller.awaitTask();
  const instance = render(<App controller={controller} fullscreen />);
  try {
    for (;;) {
      const task = await taskPromise;
      // Konuşma geçmişi: transcript'in son öğesi bu prompt → onu hariç tut (coach'a önceki turnler gider).
      const history = controller.getState().transcript.slice(0, -1).map((m) => ({ role: m.role, content: m.text }));
      controller.beginRun();
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
        controller.endRun(`hata: ${e instanceof Error ? e.message : String(e)}`);
      }
      taskPromise = controller.awaitTask(); // sonraki görev için input-mode
    }
  } finally {
    instance.unmount();
    restore();
  }
}
