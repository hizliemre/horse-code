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
