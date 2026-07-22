import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { Board, PhaseBar, Prompt, App, Message, Splash, InputLine, PendingQuestion, parsePending, RunningAgents, ChoiceInput } from "../../src/tui/components.js";
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
    await waitFrame("/model"); // palette opens, windowed around the selection (top → /model visible)
    const f = clean(lastFrame());
    expect(f).toContain("/model");
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

  it("InputLine: while a job runs, Ctrl+C is deferred (no clear/exit — App cancels the job instead)", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let val = "hello"; let cur = 5; let cleared = false;
    const onChange = (v: string): void => { val = v; if (v === "") cleared = true; };
    const { stdin, rerender, unmount } = render(<InputLine value={val} cursor={cur} onChange={onChange} onSubmit={() => {}} jobRunning />);
    await sleep(15);
    stdin.write("\x03"); await sleep(15); // Ctrl+C while running → deferred, must NOT clear the input
    rerender(<InputLine value={val} cursor={cur} onChange={onChange} onSubmit={() => {}} jobRunning />);
    expect(cleared).toBe(false);
    expect(val).toBe("hello");
    unmount();
  });

  it("ChoiceInput (multiSelect): space toggles checkboxes, Enter submits the checked options joined", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let answer: string | undefined;
    const opts = ["Library-First", "CLI Interface", "Test-First", "Observability"];
    const { stdin, lastFrame, unmount } = render(<ChoiceInput options={opts} multiSelect cols={70} onSubmit={(a) => { answer = a; }} />);
    // React 19's concurrent rendering under parallel-test load defers the raw-stdin effect + repaints;
    // poll for the first frame, then let the stdin handler attach before sending keys.
    for (let i = 0; i < 200 && !strip(lastFrame()).includes("[ ] Library-First"); i++) await sleep(15);
    expect(strip(lastFrame())).toContain("space toggle");
    await sleep(50); // stdin effect attach
    stdin.write("\x1b[B"); await sleep(25); stdin.write("\x1b[B"); await sleep(25); // → Test-First
    stdin.write(" "); await sleep(25); // check Test-First
    stdin.write("\x1b[B"); await sleep(25); stdin.write(" "); await sleep(25); // check Observability
    for (let i = 0; i < 200 && !strip(lastFrame()).includes("[x] Observability"); i++) await sleep(15);
    stdin.write("\r");
    for (let i = 0; i < 200 && answer === undefined; i++) await sleep(15);
    expect(answer).toBe("Test-First; Observability");
    unmount();
  });

  it("ChoiceInput: Esc and Ctrl+C both dismiss (onEscape), never submit", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (const key of ["\x1b", "\x03"]) {
      let escaped = false; let submitted = false;
      const { stdin, lastFrame, unmount } = render(
        <ChoiceInput options={["a", "b"]} multiSelect cols={60} onSubmit={() => { submitted = true; }} onEscape={() => { escaped = true; }} />,
      );
      for (let i = 0; i < 200 && !strip(lastFrame()).includes("[ ] a"); i++) await sleep(15);
      await sleep(50);
      stdin.write(key);
      for (let i = 0; i < 200 && !escaped; i++) await sleep(15);
      expect(escaped).toBe(true);
      expect(submitted).toBe(false);
      unmount();
    }
  });

  it("ChoiceInput (single): arrow + Enter picks one option", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let answer: string | undefined;
    const { stdin, lastFrame, unmount } = render(<ChoiceInput options={["one", "two", "three"]} multiSelect={false} cols={60} onSubmit={(a) => { answer = a; }} />);
    for (let i = 0; i < 200 && !strip(lastFrame()).includes("one"); i++) await sleep(15);
    await sleep(50); // stdin effect attach
    stdin.write("\x1b[B"); await sleep(25); stdin.write("\r");
    for (let i = 0; i < 200 && answer === undefined; i++) await sleep(15);
    expect(answer).toBe("two");
    unmount();
  });

  it("RunningAgents shows the count header + each agent's task, live duration, and model", () => {
    const agents = [
      { id: "t1", title: "add-login-endpoint", model: "cc/claude-opus-4-8", startedAt: Date.now() - 72_000 },
      { id: "t2", title: "wire-session-store", model: "opencode-go/deepseek-v4-flash", startedAt: Date.now() - 44_000 },
    ];
    const f = strip(render(<RunningAgents agents={agents} cols={90} />).lastFrame());
    expect(f).toContain("2 agents running");
    expect(f).toContain("add-login-endpoint");
    expect(f).toContain("cc/claude-opus-4-8");
    expect(f).toMatch(/1m 12s/); // live elapsed from startedAt
    expect(f).toContain("●");
  });

  it("RunningAgents uses singular 'agent' for one", () => {
    const f = strip(render(<RunningAgents agents={[{ id: "t1", title: "x", model: "m", startedAt: Date.now() }]} cols={80} />).lastFrame());
    expect(f).toContain("1 agent running");
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

  it("PendingQuestion renders the body as markdown (bold, no raw ** asterisks)", () => {
    const { lastFrame } = render(<PendingQuestion text={"\n[question] 1. **What is the project name?**\n2. **Type?**"} cols={90} />);
    const raw = lastFrame() ?? "";
    expect(strip(raw)).toContain("What is the project name?");
    expect(strip(raw)).not.toContain("**"); // markdown rendered, not literal
    expect(raw).toContain("\x1b[1m"); // bold ANSI present
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

  it("App: an unknown slash command warns and is NOT sent to the LLM", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const c = new TuiController();
    let submitted = 0;
    const orig = c.submitTask.bind(c);
    c.submitTask = (t: string): void => { submitted++; orig(t); };
    c.awaitTask();
    const { stdin, lastFrame, unmount } = render(<App controller={c} fullscreen model="m" />);
    for (let i = 0; i < 200 && !strip(lastFrame()).includes("> "); i++) await sleep(15);
    stdin.write("/foobar");
    for (let i = 0; i < 200 && !strip(lastFrame()).includes("> /foobar"); i++) await sleep(15);
    stdin.write("\r");
    for (let i = 0; i < 200 && c.getState().transcript.length === 0; i++) await sleep(15);
    expect(submitted).toBe(0); // never reached the LLM
    expect(((c.getState().transcript.at(-1) as { text?: string } | undefined)?.text)).toContain("Unknown command");
    unmount();
  });

  it("App: /roles setmodel opens the model picker", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const c = new TuiController();
    c.awaitTask();
    const { stdin, lastFrame, unmount } = render(
      <App controller={c} fullscreen model="m" listModels={async () => ["a/one"]}
        listRoles={() => [{ name: "coach", model: "cc/opus" }]} />,
    );
    for (let i = 0; i < 200 && !strip(lastFrame()).includes("> "); i++) await sleep(15);
    stdin.write("/roles setmodel");
    // poll the INPUT line (the note hint would also contain "/roles setmodel")
    for (let i = 0; i < 200 && !strip(lastFrame()).includes("> /roles setmodel"); i++) await sleep(15);
    stdin.write("\r");
    for (let i = 0; i < 200 && c.getState().mode !== "picker"; i++) await sleep(15);
    expect(c.getState().mode).toBe("picker");
    unmount();
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
