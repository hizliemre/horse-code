import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { Board, PhaseBar, Prompt, App, Message, Splash, InputLine } from "../../src/tui/components.js";
import { TuiController } from "../../src/tui/controller.js";

describe("Ink components", () => {
  it("Board shows card titles and column headers", () => {
    const { lastFrame } = render(
      <Board cards={[
        { id: "1", title: "Alpha", column: "TODO" },
        { id: "2", title: "Beta", column: "DONE" },
      ]} />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("TODO");
    expect(f).toContain("DONE");
    expect(f).toContain("Alpha");
    expect(f).toContain("Beta");
  });

  it("PhaseBar shows the phase and the detail", () => {
    const { lastFrame } = render(<PhaseBar phase="waves" detail="running" />);
    const f = lastFrame() ?? "";
    expect(f).toContain("waves");
    expect(f).toContain("running");
  });

  it("Prompt shows the question and the input caret", () => {
    const { lastFrame } = render(<Prompt question="Continue?" onSubmit={() => {}} />);
    const f = lastFrame() ?? "";
    expect(f).toContain("Continue?");
    expect(f).toContain(">");
  });

  it("App renders the initial state (friendly phase + cards)", () => {
    const c = new TuiController();
    c.onEvent({ kind: "phase", phase: "waves" });
    c.onEvent({ kind: "board", cards: [{ id: "1", title: "Alpha-task", column: "IN-PROGRESS" }] });
    const { lastFrame, unmount } = render(<App controller={c} />);
    const f = lastFrame() ?? "";
    expect(f).toContain("Coding"); // friendly phase label (waves)
    expect(f).toContain("Alpha-task");
    unmount();
  });

  it("App renders Prompt when there is a pending question", () => {
    const c = new TuiController();
    void c.ask("Do you approve?");
    const { lastFrame } = render(<App controller={c} />);
    expect(lastFrame() ?? "").toContain("Do you approve?");
  });

  it("Message user → '›' + text (no label)", () => {
    const f = render(<Message role="user" text="hello world" cols={80} />).lastFrame() ?? "";
    expect(f).toContain("›");
    expect(f).toContain("hello world");
    expect(f).not.toContain("you");
  });

  it("Message assistant → '●' circle + text (no label)", () => {
    const f = render(<Message role="assistant" text="hello" cols={80} />).lastFrame() ?? "";
    expect(f).toContain("●");
    expect(f).toContain("hello");
    expect(f).not.toContain("hcode");
  });

  it("Splash renders block-art (horse + wordmark)", () => {
    expect(render(<Splash cols={80} rows={40} />).lastFrame() ?? "").toContain("█");
  });

  it("App input mode: renders the task-input hint + box", () => {
    const c = new TuiController();
    void c.awaitTask();
    expect(render(<App controller={c} />).lastFrame() ?? "").toContain(">");
  });

  it("App mode undefined → running (one-shot preserved, board renders)", () => {
    const c = new TuiController();
    c.onEvent({ kind: "board", cards: [{ id: "1", title: "Task", column: "TODO" }] });
    const f = render(<App controller={c} />).lastFrame() ?? "";
    expect(f).toContain("Task");
    expect(f).not.toContain("Type your task");
  });

  it("App: /model opens the picker, lists models, applies a selection", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const clean = (f: string | undefined) => (f ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    const setCalls: string[] = [];
    const c = new TuiController();
    c.awaitTask(); // input mode
    const { stdin, lastFrame, unmount } = render(
      <App controller={c} fullscreen model="init/model"
        listModels={async () => ["a/one", "b/two"]}
        setModel={(m) => setCalls.push(m)} />,
    );
    await sleep(30);
    stdin.write("/model");
    await sleep(20);
    stdin.write("\r"); // submit → opens picker
    await sleep(40);   // fetch resolves
    const f = clean(lastFrame());
    expect(f).toContain("Select model");
    expect(f).toContain("a/one");
    stdin.write("\r"); // pick the first model
    await sleep(30);
    expect(setCalls).toEqual(["a/one"]);
    expect(c.getState().mode).toBe("input");
    expect(c.getState().currentModel).toBe("a/one");
    unmount();
  });

  it("App: numpad/odd escape sequences don't crash; PageUp scrolls (raw stdin, no Ink useInput)", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const clean = (f: string | undefined) => (f ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    const c = new TuiController();
    c.awaitTask();
    for (let i = 0; i < 6; i++) { c.submitTask(`line ${i} `.repeat(20)); c.endRun(`reply ${i} `.repeat(20)); c.awaitTask(); }
    const { stdin, lastFrame, unmount } = render(<App controller={c} fullscreen model="x" />);
    await sleep(30);
    stdin.write("\x1bOp"); // numpad key in application mode — Ink's parser would crash; must be ignored
    await sleep(20);
    stdin.write("\x1b[5~"); // PageUp → scroll up → the "N more" hint appears
    await sleep(20);
    expect(clean(lastFrame())).toContain("more");
    unmount();
  });

  it("InputLine: numpad app-keypad SS3 sequences type chars (incl '/') and numpad Enter submits", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let val = ""; let cur = 0; let submitted: string | undefined;
    const onChange = (v: string, c: number) => { val = v; cur = c; };
    const onSubmit = (t: string) => { submitted = t; };
    const { stdin, rerender, unmount } = render(<InputLine value={val} cursor={cur} onChange={onChange} onSubmit={onSubmit} />);
    await sleep(15);
    stdin.write("\x1bOo"); await sleep(10); rerender(<InputLine value={val} cursor={cur} onChange={onChange} onSubmit={onSubmit} />); // numpad '/'
    stdin.write("\x1bOr"); await sleep(10); rerender(<InputLine value={val} cursor={cur} onChange={onChange} onSubmit={onSubmit} />); // numpad '2'
    expect(val).toBe("/2");
    stdin.write("\x1bOM"); await sleep(10); // numpad Enter
    expect(submitted).toBe("/2");
    unmount();
  });

  it("InputLine: kitty CSI-u numpad (iTerm2 with the protocol) types chars incl '/' and numpad Enter submits", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let val = ""; let cur = 0; let submitted: string | undefined;
    const onChange = (v: string, c: number) => { val = v; cur = c; };
    const onSubmit = (t: string) => { submitted = t; };
    const { stdin, rerender, unmount } = render(<InputLine value={val} cursor={cur} onChange={onChange} onSubmit={onSubmit} />);
    await sleep(15);
    stdin.write("\x1b[57410u"); await sleep(10); rerender(<InputLine value={val} cursor={cur} onChange={onChange} onSubmit={onSubmit} />); // numpad '/'
    stdin.write("\x1b[57399u"); await sleep(10); rerender(<InputLine value={val} cursor={cur} onChange={onChange} onSubmit={onSubmit} />); // numpad '0'
    expect(val).toBe("/0");
    stdin.write("\x1b[57414u"); await sleep(10); // numpad Enter
    expect(submitted).toBe("/0");
    unmount();
  });
});
