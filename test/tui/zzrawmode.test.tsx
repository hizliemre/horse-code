import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { App, RAW_MODE_CHECK_MS } from "../../src/tui/components.js";
import { TuiController } from "../../src/tui/controller.js";

/** A stdin Ink accepts, whose raw flag can be flipped from the outside — as a child process would. */
function tty(): EventEmitter & { isTTY: boolean; isRaw: boolean; calls: boolean[]; setRawMode: (v: boolean) => void } {
  const e = new EventEmitter() as EventEmitter & {
    isTTY: boolean; isRaw: boolean; calls: boolean[]; setRawMode: (v: boolean) => void;
  };
  e.isTTY = true;
  e.isRaw = false;
  e.calls = [];
  e.setRawMode = (v: boolean): void => { e.calls.push(v); e.isRaw = v; };
  Object.assign(e, {
    ref: () => undefined, unref: () => undefined, read: () => null,
    resume: () => undefined, pause: () => undefined, setEncoding: () => undefined,
  });
  return e;
}
function screen(): EventEmitter & { isTTY: boolean; columns: number; rows: number; write: (s: string) => void } {
  const e = new EventEmitter() as EventEmitter & { isTTY: boolean; columns: number; rows: number; write: (s: string) => void };
  Object.assign(e, { isTTY: true, columns: 120, rows: 30, write: () => undefined });
  return e;
}

const mount = (stdin: ReturnType<typeof tty>) =>
  render(<App controller={new TuiController()} fullscreen />, {
    stdin: stdin as never, stdout: screen() as never, exitOnCtrlC: false, patchConsole: false,
  });

afterEach(() => { vi.useRealTimers(); });

/**
 * The tty is SHARED with everything the agents spawn.
 *
 * A child that configures it for itself — a dev server, a watcher, anything that prompts — and is then
 * KILLED rather than allowed to exit leaves the terminal in its settings, not ours. Echo comes back on, and
 * from that moment every keystroke is printed by the terminal below the last frame and wiped by the next
 * repaint. Reported after a task whose job was to run `npm start`.
 */
describe("a terminal taken by a child process is taken back", () => {
  it("re-enables raw mode when the terminal says it is off", async () => {
    vi.useFakeTimers();
    const stdin = tty();
    const app = mount(stdin);
    try {
      await vi.advanceTimersByTimeAsync(RAW_MODE_CHECK_MS * 2);
      stdin.calls.length = 0;
      stdin.isRaw = false; // a child process reset the shared terminal
      await vi.advanceTimersByTimeAsync(RAW_MODE_CHECK_MS * 2);
      expect(stdin.calls).toContain(true);
      expect(stdin.isRaw).toBe(true);
    } finally { app.unmount(); }
  });

  /** Asking for something that is already true must not turn into a call every quarter second, forever. */
  it("says nothing while the terminal is still ours", async () => {
    vi.useFakeTimers();
    const stdin = tty();
    const app = mount(stdin);
    try {
      await vi.advanceTimersByTimeAsync(RAW_MODE_CHECK_MS * 2);
      stdin.isRaw = true;
      stdin.calls.length = 0;
      await vi.advanceTimersByTimeAsync(RAW_MODE_CHECK_MS * 10);
      expect(stdin.calls).toEqual([]);
    } finally { app.unmount(); }
  });

  it("stops checking once the app is gone", async () => {
    vi.useFakeTimers();
    const stdin = tty();
    mount(stdin).unmount();
    stdin.isRaw = false;
    stdin.calls.length = 0;
    await vi.advanceTimersByTimeAsync(RAW_MODE_CHECK_MS * 10);
    expect(stdin.calls).toEqual([]);
  });
});
