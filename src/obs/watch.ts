import { spawn, type ChildProcess } from "node:child_process";

/**
 * Watches: any command, its output lines as events.
 *
 * The built-in run monitor answers three fixed questions about horse-code itself. That is the narrow case.
 * The general one is that a person building software wants to watch things the tool knows nothing about —
 * the dev server the agents just started, a CI run, a log the app writes, a health endpoint. There is no
 * useful way to enumerate those in advance, so the mechanism takes a COMMAND and treats each line it prints
 * as an event.
 *
 * That is the whole contract, and it is deliberately the same one a shell pipeline already has: anything that
 * can print a line when something happens is a watch. `tail -f app.log | grep --line-buffered ERROR` is a
 * watch. So is a curl loop, so is `gh pr checks`, so is a script the user writes.
 */

export interface WatchStatus {
  id: number;
  name: string;
  command: string;
  startedAt: number;
  /** Lines delivered. */
  events: number;
  /** Lines dropped because the watch was talking faster than anyone can read. */
  suppressed: number;
  alive: boolean;
  /** The most recent line, for the panel. */
  last?: string;
  /** Why it ended, when it has. */
  exit?: string;
}

/**
 * How much a watch may say per minute before it is throttled.
 *
 * A watch is a notification channel, not a log viewer: `tail -f` on a busy file would push a thousand lines a
 * minute into a conversation nobody could then read. Past this the lines are counted rather than shown, which
 * keeps the SIGNAL that the watch is loud without the noise.
 */
export const MAX_LINES_PER_MIN = 60;
/** Sustained flooding stops the watch outright — a channel this loud is misconfigured, not informative. */
export const SUPPRESS_LIMIT = 600;
/** One line cannot take over the screen. */
export const MAX_LINE_CHARS = 400;

interface Live {
  status: WatchStatus;
  child: ChildProcess;
  buffer: string;
  windowStart: number;
  windowCount: number;
}

/**
 * Runs watches and reports what they say.
 *
 * Lifecycle is the part that has already gone wrong once here: a command started in the same process group
 * survives being killed and keeps holding the terminal. Every watch gets its OWN group and is signalled as a
 * group, so stopping one stops everything it started.
 */
export class WatchManager {
  private readonly live = new Map<number, Live>();
  private nextId = 1;

  constructor(
    /** Called for every line a watch prints, once past the rate limit. */
    private readonly onLine: (status: WatchStatus, line: string) => void,
    private readonly onEnd: (status: WatchStatus) => void = () => undefined,
    private readonly now: () => number = () => Date.now(),
  ) {}

  start(command: string, name?: string): WatchStatus {
    const id = this.nextId++;
    const status: WatchStatus = {
      id,
      name: name?.trim() || shortName(command),
      command,
      startedAt: this.now(),
      events: 0,
      suppressed: 0,
      alive: true,
    };
    // Its own process group, stdin closed: a watch that waits for input is a watch that hangs, and a watch
    // that outlives its stop is the orphan problem all over again.
    const child = spawn(command, {
      shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const entry: Live = { status, child, buffer: "", windowStart: this.now(), windowCount: 0 };
    this.live.set(id, entry);

    const feed = (chunk: Buffer | string): void => this.consume(entry, chunk.toString());
    child.stdout?.on("data", feed);
    // stderr counts too: a watch whose command is broken must say so, not fall silent and look healthy.
    child.stderr?.on("data", feed);
    child.on("error", (e) => this.end(entry, `could not start: ${e.message}`));
    child.on("close", (code, signal) => this.end(entry, signal ? `stopped (${signal})` : `exited (${code ?? "?"})`));
    return status;
  }

  stop(id: number): boolean {
    const entry = this.live.get(id);
    if (!entry || !entry.status.alive) return false;
    this.kill(entry);
    return true;
  }

  stopAll(): void {
    for (const entry of this.live.values()) if (entry.status.alive) this.kill(entry);
  }

  list(): WatchStatus[] {
    return [...this.live.values()].map((e) => ({ ...e.status }));
  }

  private kill(entry: Live): void {
    const pid = entry.child.pid;
    try {
      if (pid) process.kill(-pid, "SIGTERM");
      else entry.child.kill("SIGTERM");
    } catch {
      try { entry.child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }

  private end(entry: Live, why: string): void {
    if (!entry.status.alive) return;
    entry.status.alive = false;
    entry.status.exit = why;
    this.onEnd({ ...entry.status });
  }

  /** Splits a chunk into lines, holds back the partial tail, and applies the rate limit. */
  private consume(entry: Live, text: string): void {
    const lines = (entry.buffer + text).split("\n");
    entry.buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "").trim();
      if (!line) continue;
      const t = this.now();
      if (t - entry.windowStart >= 60_000) {
        entry.windowStart = t;
        entry.windowCount = 0;
      }
      entry.windowCount += 1;
      if (entry.windowCount > MAX_LINES_PER_MIN) {
        entry.status.suppressed += 1;
        if (entry.status.suppressed >= SUPPRESS_LIMIT) {
          this.kill(entry);
          this.end(entry, `stopped itself — ${entry.status.suppressed} lines suppressed, it is too loud to be useful`);
        }
        continue;
      }
      entry.status.events += 1;
      entry.status.last = line.slice(0, MAX_LINE_CHARS);
      this.onLine({ ...entry.status }, entry.status.last);
    }
  }
}

/** A short label for a watch that was not given one: the command's first meaningful word. */
export function shortName(command: string): string {
  // Past the wrappers nobody means, and past the `FOO=1` assignments that `env` and the shell both allow.
  const first = command.trim().split(/\s+/)
    .find((w) => !/^(sudo|nohup|env|time)$/.test(w) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? "watch";
  return first.split("/").pop()?.slice(0, 24) || "watch";
}
