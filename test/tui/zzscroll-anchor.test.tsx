import { describe, it, expect } from "vitest";
import React from "react";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { App } from "../../src/tui/components.js";
import { TuiController } from "../../src/tui/controller.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** The accumulated stream, not the last chunk: Ink repaints differentially. */
const screen = (rows: number, columns = 120) => {
  let all = "";
  const e = Object.assign(new EventEmitter(), { isTTY: true, columns, rows,
    write: (s: string) => { all += s; } });
  return { stdout: e, frame: (): string => all, clear: (): void => { all = ""; } };
};

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

/**
 * Scrolling up during a run has to survive the run.
 *
 * The view followed the tail on every append: `useEffect(() => setScroll(0), [transcript.length])`. During a
 * coding phase that fires several times a minute, so a user who scrolled up to read something was pulled back
 * to the bottom before they could finish. Reported live, while a coder was working: "scroll çok hızlı bir
 * şekilde küçülüyor ancak chat'e aynı oranda birşey basılmıyor" — the position was being reset, not the
 * screen filled. A run of tool calls folds into ONE row that updates in place, so the chat barely changes
 * while the item count keeps ticking.
 *
 * `scroll` is a distance from the BOTTOM, so holding it still does not hold the content still either: every
 * appended line pushes the reader one line further through text they have not read.
 */
describe("scrolling back through a run", () => {
  const withApp = async (rows: number, fn: (c: TuiController, s: ReturnType<typeof screen>) => Promise<void>) => {
    const c = new TuiController();
    const s = screen(rows);
    const app = render(<App controller={c} fullscreen />, { stdout: s.stdout as never, patchConsole: false, exitOnCtrlC: false });
    try { await fn(c, s); } finally { app.unmount(); }
  };

  it("holds its place while a run of tool calls folds into one growing row", async () => {
    await withApp(20, async (c, s) => {
      for (let i = 0; i < 60; i++) c.note(`OLD-${i}`);
      await settle();
      for (let i = 0; i < 8; i++) process.stdin.emit("data", "\x1b[A");
      await settle();
      s.clear();
      /**
       * The case the report was about: consecutive successful calls fold into ONE transcript item that is
       * replaced in place. The item COUNT barely moves while the row itself grows a line per new target — so
       * an effect watching the count sees nothing and a view anchored to the bottom slides anyway.
       */
      for (let i = 0; i < 25; i++) {
        c.pushActivity({ tool: "read_file", target: `file-${i}.ts`, summary: `${i} lines`, ok: true } as never);
      }
      await settle();
      expect(strip(s.frame())).not.toContain("file-24.ts");
    });
  });

  it("keeps the same lines on screen when new ones are appended", async () => {
    await withApp(20, async (c, s) => {
      for (let i = 0; i < 60; i++) c.note(`OLD-${i}`);
      await settle();
      // Scroll up by a page-worth, the way a person reading back does.
      for (let i = 0; i < 8; i++) process.stdin.emit("data", "\x1b[A");
      await settle();
      s.clear();
      for (let i = 0; i < 12; i++) c.note(`NEW-${i}`);
      await settle();
      const f = strip(s.frame());
      // Whatever was visible stayed visible: the newest lines did not take the screen.
      expect(f).not.toContain("NEW-11");
    });
  });

  it("follows the tail for a user who never scrolled — that was always right", async () => {
    await withApp(24, async (c, s) => {
      for (let i = 0; i < 10; i++) c.note(`start ${i}`);
      await settle();
      s.clear();
      c.note("THE LATEST THING");
      await settle();
      expect(strip(s.frame())).toContain("THE LATEST THING");
    });
  });
});
