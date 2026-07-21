import React from "react";
import { render } from "ink";
import type { LineReader } from "../terminal.js";
import { makeAskUser } from "../terminal.js";
import { runJob } from "../engine/job.js";
import type { JobDeps, JobResult } from "../engine/job.js";
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
