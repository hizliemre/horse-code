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
