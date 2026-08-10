import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { restoreTerminal, restoreOnExit, RESET_SEQUENCE } from "../../src/tui/restore-terminal.js";

const handles = () => {
  const written: string[] = [];
  let raw = true;
  return {
    written,
    isRaw: () => raw,
    h: {
      stdin: { isTTY: true, setRawMode: (v: boolean) => { raw = v; } },
      write: (s: string) => written.push(s),
    },
  };
};

/**
 * Reported after a real session: quitting horse-code left the shell echoing `^M` for Enter and `^C` for
 * interrupt, with commands typed as `clear^M^C^C^C…` and never executed. That is a terminal still in raw
 * mode — the shell receiving keystrokes it was never meant to interpret.
 *
 * `process.exit()` does not unmount Ink, so Ink's own cleanup never ran on the paths that call it.
 */
describe("restoreTerminal", () => {
  it("puts the terminal back into cooked mode", () => {
    const t = handles();
    restoreTerminal(t.h);
    expect(t.isRaw()).toBe(false);
  });

  it("undoes the display modes it borrowed", () => {
    const t = handles();
    restoreTerminal(t.h);
    expect(t.written.join("")).toBe(RESET_SEQUENCE);
  });

  /** Raw mode is the one whose absence makes the shell unusable — a failing write must not skip it. */
  it("still leaves cooked mode when the write throws", () => {
    let raw = true;
    restoreTerminal({
      stdin: { isTTY: true, setRawMode: (v: boolean) => { raw = v; } },
      write: () => { throw new Error("stream closed"); },
    });
    expect(raw).toBe(false);
  });

  it("does nothing to a stream that is not a terminal", () => {
    const calls: boolean[] = [];
    restoreTerminal({ stdin: { isTTY: false, setRawMode: (v: boolean) => calls.push(v) }, write: () => undefined });
    expect(calls).toEqual([]);
  });

  it("is safe to call twice", () => {
    const t = handles();
    restoreTerminal(t.h); restoreTerminal(t.h);
    expect(t.isRaw()).toBe(false);
  });
});

/**
 * Node runs NO exit handler for a signal it handles by default, so a `kill` or a Ctrl+C that reaches the
 * process would otherwise leave the terminal raw.
 */
describe("restoreOnExit", () => {
  const fakeProc = () => Object.assign(new EventEmitter(), { pid: 1234, kill: vi.fn() }) as unknown as NodeJS.Process;

  it("restores when the process exits normally", () => {
    const t = handles(); const p = fakeProc();
    restoreOnExit(t.h, p);
    (p as unknown as EventEmitter).emit("exit", 0);
    expect(t.isRaw()).toBe(false);
  });

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    it(`restores on ${sig}, then lets the default handler have it`, () => {
      const t = handles(); const p = fakeProc();
      restoreOnExit(t.h, p);
      (p as unknown as EventEmitter).emit(sig);
      expect(t.isRaw()).toBe(false);
      expect((p as unknown as { kill: ReturnType<typeof vi.fn> }).kill).toHaveBeenCalledWith(1234, sig);
    });
  }

  it("removes its handlers when asked, so a caller can own the exit itself", () => {
    const t = handles(); const p = fakeProc();
    restoreOnExit(t.h, p)();
    (p as unknown as EventEmitter).emit("exit", 0);
    expect(t.isRaw()).toBe(true); // untouched
  });
});

/**
 * The signal path used to bypass the app's own quit policy: one SIGINT restored the terminal and re-raised,
 * so the process died at once. In raw mode Ctrl+C is `\x03` data and never gets here — but a run spends much
 * of its time inside subprocesses that hold the foreground terminal, and a Ctrl+C then sends a real SIGINT to
 * the whole process group. Reported as "it closed itself and went back to the shell", mid-run.
 */
describe("an interrupt is negotiable; a termination is not", () => {
  const fakeProc = () => {
    const listeners = new Map<string, (() => void)[]>();
    const killed: string[] = [];
    return {
      killed,
      raise: (sig: string): void => {
        const fns = listeners.get(sig) ?? [];
        listeners.set(sig, []); // `once` semantics
        for (const f of fns) f();
      },
      proc: {
        pid: 1,
        once: (sig: string, fn: () => void) => { listeners.set(sig, [...(listeners.get(sig) ?? []), fn]); },
        removeListener: (sig: string, fn: () => void) => {
          listeners.set(sig, (listeners.get(sig) ?? []).filter((f) => f !== fn));
        },
        kill: (_pid: number, sig: string) => { killed.push(sig); },
      } as unknown as NodeJS.Process,
    };
  };
  const handles = () => ({ stdin: { isTTY: true, setRawMode: () => {} }, write: () => {} });

  it("lets the app keep the process when it handles the interrupt", () => {
    const f = fakeProc();
    restoreOnExit(handles(), f.proc, () => true);
    f.raise("SIGINT");
    expect(f.killed).toEqual([]); // still alive — the job was cancelled, not the app
  });

  it("re-arms, so a second interrupt is handled too", () => {
    const f = fakeProc();
    let seen = 0;
    restoreOnExit(handles(), f.proc, () => { seen++; return true; });
    f.raise("SIGINT");
    f.raise("SIGINT");
    expect(seen).toBe(2);
    expect(f.killed).toEqual([]);
  });

  it("exits when the app declines to handle it — the escape hatch still works", () => {
    const f = fakeProc();
    restoreOnExit(handles(), f.proc, () => false);
    f.raise("SIGINT");
    expect(f.killed).toEqual(["SIGINT"]);
  });

  /** The system is telling us to go, and we go. */
  it("never negotiates SIGTERM or SIGHUP", () => {
    for (const sig of ["SIGTERM", "SIGHUP"]) {
      const f = fakeProc();
      restoreOnExit(handles(), f.proc, () => true);
      f.raise(sig);
      expect(f.killed).toEqual([sig]);
    }
  });

  it("exits on an interrupt when no policy is given at all", () => {
    const f = fakeProc();
    restoreOnExit(handles(), f.proc);
    f.raise("SIGINT");
    expect(f.killed).toEqual(["SIGINT"]);
  });
});

/**
 * The `^M` came back.
 *
 * Reported once, fixed by restoring raw mode explicitly, and reported again: after quitting, Enter echoed as
 * `^M` and `hcode^M` sat at the prompt unexecuted.
 *
 * `setRawMode(false)` puts back the termios Node captured when IT first took the terminal — which is the
 * right answer only if nothing else touched the terminal since. A run spends much of its time inside
 * subprocesses that hold the foreground tty (`docker exec`, `psql`, a dev server), and any of them can leave
 * it in a state Node's cached copy knows nothing about.
 *
 * So the last thing on the way out asks the system, not the cache. `stty sane` is exactly what the user had
 * to type to get their shell back, and it costs one spawn on a path that is already ending.
 */
describe("the last resort on the way out", () => {
  it("asks the system to sanitise the terminal, after doing everything else", () => {
    const order: string[] = [];
    restoreTerminal({
      stdin: { isTTY: true, setRawMode: () => order.push("rawMode(false)") },
      write: () => order.push("escape-sequences"),
      sane: () => order.push("stty sane"),
    });
    expect(order).toEqual(["rawMode(false)", "escape-sequences", "stty sane"]);
  });

  /**
   * Deliberately NOT gated on `stdin.isTTY`: that flag is a belief about a stream, and by exit time the
   * stream has been paused and handed back. A belief that is wrong here skips the one step that works.
   * `sttySane` asks the system — it opens `/dev/tty` and fails harmlessly when there is none.
   */
  it("still asks, even when the stream no longer claims to be a terminal", () => {
    const order: string[] = [];
    restoreTerminal({ stdin: { isTTY: false }, write: () => order.push("w"), sane: () => order.push("stty sane") });
    expect(order).toContain("stty sane");
  });

  it("survives a sane that fails — a terminal already gone needs nothing put back", () => {
    expect(() => restoreTerminal({
      stdin: { isTTY: true, setRawMode: () => {} },
      write: () => {},
      sane: () => { throw new Error("no stty here"); },
    })).not.toThrow();
  });
});

/**
 * Every caller has to bring `sane`, and one did not.
 *
 * The re-exec parent is the LAST-CHANCE restore: the TUI runs in a child, and when that child dies hard its
 * own handlers never run. That path called `restoreTerminal` without `sane` — so all it had was
 * `setRawMode(false)`, and on the parent that is worse than nothing: the parent never touched the terminal,
 * so reading `process.stdin` there initialises the handle and captures the CURRENT state as libuv's
 * "original". The broken state becomes the baseline, and is faithfully restored.
 *
 * Reported three times, the third with the terminal measured: `-icanon -isig -icrnl`, `clear^M^C^C^C` at the
 * prompt. Asserted on the source because the path re-execs the process and cannot be run inside a test.
 */
describe("every restore on the way out asks the system too", () => {
  it("is wired that way at the re-exec parent, the one that outlives a hard kill", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/cli.ts", "utf8");
    for (const call of src.match(/restoreTerminal\(\{[^}]*\}\)/g) ?? []) {
      expect(call, call).toContain("sane:");
    }
  });

  /** …and a child killed by a signal is not reported as a clean exit. */
  it("does not turn a hard kill into a success", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/cli.ts", "utf8");
    expect(src).toContain("if (r.signal) process.kill(process.pid, r.signal);");
  });
});

/**
 * The parent that hands the terminal back has to outlive the child that borrowed it.
 *
 * Ctrl+C reaches the whole foreground process group. The child handles it — that is its two-step cancel —
 * and the parent had no handler, so the parent died instantly while the TUI carried on in raw mode and the
 * shell took its prompt back with a live raw-mode reader still on the tty. Reported as "quitting breaks the
 * terminal, especially at a question", which is where the child lives longest.
 *
 * And the restore the runtime does for us has to be the RIGHT one: node puts the tty back the way libuv
 * found it, so the snapshot must be taken while the terminal is still cooked — before the child is spawned,
 * not at exit. Measured in a pty: `stty sane` inside a node process works and is reverted when it exits.
 */
describe("the re-exec parent", () => {
  const src = async (): Promise<string> => (await import("node:fs/promises")).readFile("src/cli.ts", "utf8");

  it("takes the terminal snapshot before the child can make it raw", async () => {
    const s = await src();
    const snapshot = s.indexOf("if (process.stdin.isTTY) process.stdin.setRawMode(false);");
    const spawn = s.indexOf("spawnSync(process.execPath");
    expect(snapshot).toBeGreaterThan(-1);
    expect(snapshot).toBeLessThan(spawn);
  });

  it("does not die on the interrupt the child is handling", async () => {
    const s = await src();
    expect(s).toContain('const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;');
    const install = s.indexOf("for (const sig of SIGNALS) process.on(sig, ignore);");
    const spawn = s.indexOf("spawnSync(process.execPath");
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(spawn);
  });

  /** …and the handlers come off before the exit code is re-raised, or it would be swallowed. */
  it("stands the handlers down before reporting how the child died", async () => {
    const s = await src();
    const off = s.indexOf("for (const sig of SIGNALS) process.removeListener(sig, ignore);");
    const raise = s.indexOf("if (r.signal) process.kill(process.pid, r.signal);");
    expect(off).toBeGreaterThan(-1);
    expect(off).toBeLessThan(raise);
  });
});
