import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";

/**
 * Asking the person at the terminal a question, for the setup commands that need one.
 *
 * Read from `/dev/tty` rather than from stdin, so these still work when this process's stdin is a pipe —
 * which it is whenever horse-code is invoked from a script or another tool. Nothing here is part of a run;
 * these are for `add-provider` and `remove-provider`, where a person is present by definition.
 *
 * `undefined` when there is no terminal at all. A non-interactive caller gets a clean refusal instead of a
 * process that blocks forever waiting for somebody who is not there.
 */

/** One line from the terminal, echoed as it is typed. */
export function promptLine(): string | undefined {
  return readTty(false);
}

/**
 * One line from the terminal, NOT echoed — for a key or a password.
 *
 * A secret pasted into a visible prompt survives in scrollback, in a screen share, and in whatever recorded
 * the session. It is never passed as an argument either, which would put it in the process table and in
 * shell history.
 */
export function promptSecret(): string | undefined {
  return readTty(true);
}

/**
 * A yes/no question, refused by default.
 *
 * "No" is the answer to anything typed by accident, to a bare Enter, and to there being no terminal at all —
 * which matters because the only caller deletes a directory holding a sign-in.
 */
export function confirm(question: string): boolean {
  process.stdout.write(`${question} [y/N] `);
  const answer = promptLine();
  process.stdout.write("\n");
  return /^y(es)?$/i.test((answer ?? "").trim());
}

function readTty(hidden: boolean): string | undefined {
  let fd: number;
  try { fd = openSync("/dev/tty", "r"); } catch { return undefined; }
  const hushed = hidden && spawnSync("stty", ["-echo"], { stdio: ["inherit", "ignore", "ignore"] }).status === 0;
  try {
    const buf = Buffer.alloc(1);
    let out = "";
    for (;;) {
      let n = 0;
      try { n = readSync(fd, buf, 0, 1, null); } catch { break; }
      if (n === 0) break;
      const ch = buf.toString("utf8");
      if (ch === "\n" || ch === "\r") break;
      out += ch;
    }
    return out.trim() || undefined;
  } finally {
    // Restored even when the read threw: leaving a terminal with echo off makes the shell look broken.
    if (hushed) spawnSync("stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] });
    closeSync(fd);
  }
}
