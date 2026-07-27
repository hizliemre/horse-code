import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolResult } from "../core/types.js";

const params = z.object({
  command: z.string(),
  /** Milliseconds before the command is killed. Defaults to DEFAULT_TIMEOUT_MS, capped at MAX_TIMEOUT_MS. */
  timeout: z.number().int().positive().optional(),
});

/**
 * Default wall-clock budget for one command.
 *
 * There was NO timeout at all: `ng serve`, `npm run watch`, a stalled install — or any command that reads
 * stdin — blocked forever. A single task was observed running 378 minutes, and the only thing that ever
 * stopped it was the (much later) implementer budget.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** Upper bound a caller may ask for. A genuinely long build says so explicitly; nothing runs unbounded. */
export const MAX_TIMEOUT_MS = 600_000;
/** Grace period between SIGTERM and SIGKILL, so a process gets a chance to clean up. */
const KILL_GRACE_MS = 2_000;

/**
 * Cap on how much command output enters the conversation (~8k tokens).
 *
 * A build or install log is tens of thousands of characters, and once it is in the conversation it is re-sent
 * on EVERY subsequent turn — a single `ng build` was being billed dozens of times over. What matters in a long
 * log is the START (what ran, early errors) and the END (the failure and the summary); the middle is noise.
 */
export const MAX_SHELL_CHARS = 32_000;
/** How much of the budget goes to the tail — the failure and the exit summary usually live there. */
const TAIL_SHARE = 0.6;

/** Trims a long log to its head and tail, saying plainly what was dropped. */
export function clampOutput(body: string, max = MAX_SHELL_CHARS): string {
  if (body.length <= max) return body;
  const tail = Math.floor(max * TAIL_SHARE);
  const head = max - tail;
  const dropped = body.length - max;
  const lines = body.slice(head, body.length - tail).split("\n").length;
  return `${body.slice(0, head)}\n\n… [${dropped.toLocaleString("en-US")} chars / ~${lines} lines trimmed from the middle] …\n\n${body.slice(-tail)}`;
}

export const shellTool: Tool = {
  name: "shell",
  description:
    "Runs a shell command (in the cwd context). Returns stdout+stderr and the exit code. Runs NON-INTERACTIVELY " +
    "(stdin is closed) — pass non-interactive flags (e.g. --yes, --no-input) or the command will fail rather " +
    "than wait for input. Killed after `timeout` ms (default 120000, max 600000); do not start long-running " +
    "watchers or dev servers.",
  permissionLevel: "exec",
  parameters: params,
  describe(rawArgs) {
    const a = params.parse(rawArgs);
    return { allowKey: a.command, preview: a.command };
  },
  run(rawArgs, ctx) {
    const parsed = params.safeParse(rawArgs);
    if (!parsed.success) {
      return Promise.resolve({
        content: `shell: invalid args: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        isError: true,
      });
    }
    const a = parsed.data;
    return new Promise<ToolResult>((resolvePromise) => {
      let child;
      try {
        // stdin is CLOSED, not piped: a command that asks a question (npm init, a package manager's y/n)
        // otherwise waits on input that will never come, and the whole agent stalls behind it.
        /**
         * Its OWN process group, so that killing it kills everything it started.
         *
         * With `shell: true` the child is `/bin/sh`; `child.kill()` reaches the shell and nothing else. A
         * command like `npm start` therefore survived its own timeout as an orphan — still holding the
         * terminal it was sharing with us, still running long after the agent had moved on. Detached, the
         * whole tree can be signalled at once with a negative pid.
         */
        child = spawn(a.command, {
          cwd: ctx.cwd, shell: true, signal: ctx.signal, stdio: ["ignore", "pipe", "pipe"], detached: true,
        });
      } catch (e) {
        resolvePromise({
          content: `shell error: ${e instanceof Error ? e.message : String(e)}`,
          isError: true,
        });
        return;
      }
      const budget = Math.min(a.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      let out = "";
      let err = "";
      let timedOut = false;
      let killer: NodeJS.Timeout | undefined;
      /** Signals the whole group. Falls back to the child alone if the group is already gone. */
      const killTree = (sig: NodeJS.Signals): void => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch {
          try { child.kill(sig); } catch { /* already dead */ }
        }
      };
      // An abort reaches `/bin/sh` through spawn's own signal handling; everything BELOW it is ours to end.
      const onAbort = (): void => killTree("SIGKILL");
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        killTree("SIGTERM");
        // Escalate if it ignores SIGTERM — otherwise "timed out" would still leave the process running.
        killer = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
        killer.unref?.();
      }, budget);
      timer.unref?.(); // a pending timer must never keep the process alive on its own
      const done = (): void => {
        clearTimeout(timer);
        if (killer) clearTimeout(killer);
        ctx.signal?.removeEventListener("abort", onAbort);
      };
      child.stdout?.on("data", (d) => (out += d.toString()));
      child.stderr?.on("data", (d) => (err += d.toString()));
      child.on("error", (e) => {
        done();
        resolvePromise({ content: `shell error: ${e.message}`, isError: true });
      });
      child.on("close", (code) => {
        done();
        const body = clampOutput([out, err].filter((s) => s.length).join("\n").trimEnd());
        // Whatever it printed before being killed is kept — a timed-out build's output is usually the point.
        const tail = timedOut
          ? `\n(killed after ${Math.round(budget / 1000)}s — it was still running. Use a non-interactive, terminating command; do not start watchers or dev servers.)`
          : `\n(exit ${code ?? "null"})`;
        resolvePromise({ content: `$ ${a.command}\n${body}${tail}`, isError: timedOut || code !== 0 });
      });
    });
  },
};
