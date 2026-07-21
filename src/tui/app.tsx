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
  // awaitTask'i render'dan ÖNCE çağır → ilk render input-mode (Prompt + useInput aktif) →
  // Ink stdin'i tutar (aksi halde useInput'suz running-mode render boşta çıkardı).
  let taskPromise = controller.awaitTask();
  const instance = render(<App controller={controller} />);
  try {
    for (;;) {
      const task = await taskPromise;
      controller.beginRun();
      try {
        const res = await runJob(deps, {
          ...opts.jobBase,
          prompt: task,
          jobName: toSlug(task) || "hcode-job",
          askUser: makeAskUser(read),
          onEvent: controller.onEvent,
        });
        controller.endRun(opts.formatResult(res));
      } catch (e) {
        controller.endRun(`hata: ${e instanceof Error ? e.message : String(e)}`);
      }
      taskPromise = controller.awaitTask(); // sonraki görev için input-mode
    }
  } finally {
    instance.unmount();
  }
}
