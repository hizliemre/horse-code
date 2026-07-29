import { describe, it, expect } from "vitest";
import React from "react";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { closesHelp, App } from "../../src/tui/components.js";
import { TuiController } from "../../src/tui/controller.js";

/**
 * The help overlay REPLACES the input line, so nothing else can close it.
 *
 * Its key test compared whole chunks for equality, and a chunk is not a keystroke: fast typing, a paste and
 * a terminal that batches its writes all deliver several bytes at once. None of those forms matched, and the
 * overlay stayed up.
 */
describe("closesHelp", () => {
  it("accepts the keys the overlay documents", () => {
    expect(closesHelp("q")).toBe(true);
    expect(closesHelp("?")).toBe(true);
    expect(closesHelp("\x1b")).toBe(true);
  });

  it("accepts them batched, which is how a terminal often sends them", () => {
    expect(closesHelp("q\r")).toBe(true);
    expect(closesHelp("q\n")).toBe(true);
    expect(closesHelp("Q\r\n")).toBe(true);
  });

  /** It is what anyone reaches for when a screen will not go away. */
  it("accepts Ctrl+C", () => {
    expect(closesHelp("\x03")).toBe(true);
  });

  it("ignores ordinary typing", () => {
    expect(closesHelp("a")).toBe(false);
    expect(closesHelp("hello")).toBe(false);
  });
});

/**
 * The whole frame must fit the terminal, whatever is happening at once.
 *
 * Rendered end to end rather than asserted on the height maths: the two disagreeing IS the bug — a frame
 * taller than the screen makes the terminal scroll, carries the input box off the top, and every keystroke
 * after that lands at the bottom and is wiped by the next repaint.
 */
describe("the frame never exceeds the terminal height", () => {
  const strip = (f: string | undefined): string => (f ?? "").replace(/\x1b\[[0-9;]*m/g, "");

  const busy = (agents: number): TuiController => {
    const c = new TuiController();
    c.beginRun();
    c.onEvent({ kind: "agents", agents: Array.from({ length: agents }, (_, i) => ({
      id: `t${i}`, title: `implement a fairly long task title number ${i}`, model: "opencode-go/glm-5.1",
    })) });
    c.selectAgent(1);                                   // opens the detail box
    for (let i = 0; i < 6; i++) c.pushActivity({ agent: "t0", tool: "shell", target: `command ${i}`, lines: 0, summary: "" });
    c.addInboxNote("how many tasks are left?", () => {});
    c.liveNote()("There are 63 tasks in TODO. ".repeat(6));
    c.onEvent({ kind: "note", text: "a note".repeat(20) });
    return c;
  };

  /** A stdout of a chosen height that keeps the last frame Ink wrote to it. */
  const screen = (rows: number) => {
    let last = "";
    const e = Object.assign(new EventEmitter(), {
      isTTY: true, columns: 120, rows,
      write: (s: string) => { if (s.includes("\n")) last = s; },
    });
    return { stdout: e, frame: (): string => last };
  };

  for (const rows of [14, 20, 24, 30, 40]) {
    it(`fits ${rows} rows with eight agents and a detail box`, async () => {
      const { stdout, frame } = screen(rows);
      const app = render(<App controller={busy(8)} fullscreen />, {
        stdout: stdout as never, patchConsole: false, exitOnCtrlC: false,
      });
      try {
        await new Promise((r) => setTimeout(r, 60));
        const lines = strip(frame()).replace(/\n$/, "").split("\n").length;
        expect(lines).toBeLessThanOrEqual(rows);
      } finally { app.unmount(); }
    });
  }
});
