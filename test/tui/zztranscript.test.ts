import { describe, it, expect } from "vitest";
import { TuiController, MAX_TRANSCRIPT_ITEMS } from "../../src/tui/controller.js";

// A 7.5-hour run reached a 4 GB heap and died with "JavaScript heap out of memory". The renderer flattens the
// WHOLE transcript into styled lines on every frame, so an unbounded transcript makes per-frame work grow
// without limit — on top of the retained transcript itself.
describe("the live transcript is bounded", () => {
  const flood = (c: TuiController, n: number): void => {
    for (let i = 0; i < n; i++) c.onEvent({ kind: "note", text: `note ${i}` });
  };

  it("keeps the newest items and drops the oldest", () => {
    const c = new TuiController();
    flood(c, MAX_TRANSCRIPT_ITEMS + 500);
    const t = c.getState().transcript;
    expect(t).toHaveLength(MAX_TRANSCRIPT_ITEMS);
    const last = t.at(-1);
    expect(last && "text" in last ? last.text : "").toBe(`note ${MAX_TRANSCRIPT_ITEMS + 499}`);
    const first = t[0];
    expect(first && "text" in first ? first.text : "").toBe("note 500"); // the oldest 500 are gone
  });

  it("does not touch a transcript that is still under the cap", () => {
    const c = new TuiController();
    flood(c, 10);
    expect(c.getState().transcript).toHaveLength(10);
  });

  it("bounds tool activity too — file writes are the highest-volume source", () => {
    const c = new TuiController();
    for (let i = 0; i < MAX_TRANSCRIPT_ITEMS + 200; i++) {
      c.pushActivity({ tool: "write", target: `src/f${i}.ts`, lines: 12, preview: ["a", "b"], startLine: 1 });
    }
    expect(c.getState().transcript).toHaveLength(MAX_TRANSCRIPT_ITEMS);
  });

  it("bounds a mixed stream of notes, prompts and activity", () => {
    const c = new TuiController();
    for (let i = 0; i < 800; i++) {
      c.onEvent({ kind: "note", text: `n${i}` });
      c.pushActivity({ tool: "edit", target: "a.ts", lines: 3 });
    }
    expect(c.getState().transcript.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_ITEMS);
  });

  // The window is a VIEW concern: the durable conversation is persisted by the session store separately.
  it("the retained window is still large enough to be useful scrollback", () => {
    expect(MAX_TRANSCRIPT_ITEMS).toBeGreaterThanOrEqual(1000);
  });

  // Capping is a VIEW concern. The saved session and the coach's history must still see the whole run.
  it("archives the messages it drops — persistence stays lossless", () => {
    const c = new TuiController();
    for (let i = 0; i < MAX_TRANSCRIPT_ITEMS + 300; i++) c.onEvent({ kind: "note", text: `note ${i}` });
    const msgs = c.messages();
    expect(msgs).toHaveLength(MAX_TRANSCRIPT_ITEMS + 300); // nothing lost
    expect(msgs[0].text).toBe("note 0");                    // including the very first turn
    expect(msgs.at(-1)!.text).toBe(`note ${MAX_TRANSCRIPT_ITEMS + 299}`);
  });

  it("does not archive tool activity — only conversation is persisted", () => {
    const c = new TuiController();
    for (let i = 0; i < MAX_TRANSCRIPT_ITEMS + 100; i++) {
      c.pushActivity({ tool: "write", target: `f${i}.ts`, lines: 1 });
    }
    expect(c.messages()).toEqual([]);
  });
});
