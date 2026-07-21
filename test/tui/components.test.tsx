import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { Board, PhaseBar, Prompt, App, Message, Splash, InputLine, PendingQuestion, parsePending } from "../../src/tui/components.js";
import { TuiController } from "../../src/tui/controller.js";

const strip = (f: string | undefined): string => (f ?? "").replace(/\x1b\[[0-9;]*m/g, "");

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
    // The shimmer status line tints each character separately → strip ANSI to read the label back.
    const f = (lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
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
    // React 19's concurrent rendering + parallel test load make raw sleeps flaky: the controlled input
    // only reflects a keystroke after a re-render, and the picker paints a frame after that. So wait for
    // each render to settle (poll the frame / controller state) before the next keystroke.
    const waitFrame = async (text: string): Promise<void> => {
      for (let i = 0; i < 200 && !clean(lastFrame()).includes(text); i++) await sleep(15);
    };
    const waitState = async (cond: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !cond(); i++) await sleep(15);
    };
    await waitFrame("> "); // input painted
    stdin.write("/model");
    await waitFrame("/model"); // input re-rendered with the typed text (so onSubmit sees "/model")
    stdin.write("\r"); // submit → opens picker
    await waitState(() => c.getState().mode === "picker" && !c.getState().picker?.loading && (c.getState().picker?.models.length ?? 0) > 0);
    await waitFrame("a/one"); // models painted
    expect(clean(lastFrame())).toContain("Select model");
    expect(clean(lastFrame())).toContain("a/one");
    await sleep(40); // let ModelPicker's stdin effect attach before the selecting keystroke
    stdin.write("\r"); // pick the first model
    await waitState(() => c.getState().mode === "input");
    expect(setCalls).toEqual(["a/one"]);
    expect(c.getState().mode).toBe("input");
    expect(c.getState().currentModel).toBe("a/one");
    unmount();
  });

  it("App: '/' opens the slash palette; typing filters it; → completes; Enter runs the command", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const clean = (f: string | undefined) => (f ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    const c = new TuiController();
    c.awaitTask();
    // seed a transcript so /clear has something to clear
    c.submitTask("earlier prompt"); c.endRun("earlier answer");
    const { stdin, lastFrame, unmount } = render(<App controller={c} fullscreen model="m" coachModel="cc/opus" />);
    const waitFrame = async (t: string): Promise<void> => {
      for (let i = 0; i < 200 && !clean(lastFrame()).includes(t); i++) await sleep(15);
    };
    const waitState = async (cond: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !cond(); i++) await sleep(15);
    };
    await waitFrame("> ");
    stdin.write("/");
    await waitFrame("/exit"); // palette lists every command
    const f = clean(lastFrame());
    expect(f).toContain("/model");
    expect(f).toContain("/clear");
    expect(f).toContain("Enter run"); // hint line
    stdin.write("cl"); // filter → only /clear
    // wait for the filter to actually apply (/model gone) — "/clear" alone is ambiguous since its
    // description is present in the unfiltered list too.
    for (let i = 0; i < 200 && clean(lastFrame()).includes("/model"); i++) await sleep(15);
    expect(clean(lastFrame())).not.toContain("/model");
    expect(clean(lastFrame())).toContain("/clear");
    stdin.write("\x1b[C"); // → completes the selected command into the input
    await waitFrame("> /clear");
    stdin.write("\r"); // run /clear
    await waitState(() => c.getState().transcript.length === 0);
    expect(c.getState().transcript).toEqual([]);
    expect(c.getState().mode).toBe("input");
    unmount();
  });

  it("parsePending strips the [question]/[permission]/[human] tag + leading newline", () => {
    expect(parsePending("\n[question] What now?")).toEqual({ kind: "question", body: "What now?" });
    expect(parsePending("\n[permission] rm -rf\napprove? (y/n)").kind).toBe("permission");
    expect(parsePending("\n[human] task X").kind).toBe("human");
    expect(parsePending("no tag here")).toEqual({ kind: "question", body: "no tag here" });
  });

  it("PendingQuestion renders the '? Question' header + clean body (no raw tag)", () => {
    const f = strip(render(<PendingQuestion text={"\n[question] Which stack?\n1. Python\n2. TS"} cols={80} />).lastFrame());
    expect(f).toContain("? Question");
    expect(f).toContain("Which stack?");
    expect(f).toContain("1. Python");
    expect(f).not.toContain("[question]");
  });

  it("App: while a question is pending, the 'refining' status is hidden and the question renders cleanly", () => {
    const c = new TuiController();
    c.awaitTask(); c.submitTask("x"); c.beginRun();
    c.onEvent({ kind: "phase", phase: "upstream" }); // would show "refining…" if not pending
    void c.ask("\n[question] Clarify the scope please");
    const f = strip(render(<App controller={c} fullscreen model="m" coachModel="cc/opus" />).lastFrame());
    expect(f).toContain("? Question");
    expect(f).toContain("Clarify the scope please");
    expect(f).not.toContain("refining"); // the running status is hidden while blocked on the user
    expect(f).not.toContain("[question]");
  });

  it("App: after a chat turn finishes, shows the 'zottired for Xm XXs' completion line", () => {
    let t = 0;
    const c = new TuiController(() => t);
    c.awaitTask(); c.submitTask("x"); c.beginRun();
    c.onEvent({ kind: "phase", phase: "upstream" });
    c.onEvent({ kind: "phase", phase: "chat" }); // coach phase = zottiring
    t = 83_000; // 1m 23s elapsed
    c.awaitTask(); c.submitTask("y"); c.endRun("answer");
    const clean = (f: string | undefined) => (f ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    const { lastFrame, unmount } = render(<App controller={c} fullscreen model="m" coachModel="cc/opus" />);
    expect(clean(lastFrame())).toContain("zottired for 1m 23s");
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
    // Poll the frame (React 19 concurrent rendering under parallel-test load can defer the repaint).
    for (let i = 0; i < 200 && !clean(lastFrame()).includes("more"); i++) await sleep(15);
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
