import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { Board, PhaseBar, Prompt, App, Message, Splash, InputLine, PendingQuestion, parsePending, RunningAgents, agentDetail, agentActivity, LONG_RUNNING_MS, RunMonitor, monitorLines, ChoiceInput } from "../../src/tui/components.js";
import { TuiController } from "../../src/tui/controller.js";
import type { WatchStatus } from "../../src/obs/watch.js";

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

  it("App renders the running phase label — NO kanban board (progress shows as action notes)", () => {
    const c = new TuiController();
    c.onEvent({ kind: "phase", phase: "waves" });
    c.onEvent({ kind: "board", cards: [{ id: "1", title: "Alpha-task", column: "IN-PROGRESS" }] });
    const { lastFrame, unmount } = render(<App controller={c} />);
    // The shimmer status line tints each character separately → strip ANSI to read the label back.
    const f = (lastFrame() ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    expect(f).toContain("Coding"); // friendly phase label (waves)
    expect(f).not.toContain("Alpha-task"); // the kanban board is gone from the chat UI
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

  it("App mode undefined → running (one-shot preserved; not the input prompt)", () => {
    const c = new TuiController();
    c.onEvent({ kind: "phase", phase: "waves" });
    c.onEvent({ kind: "board", cards: [{ id: "1", title: "Task", column: "TODO" }] });
    const f = render(<App controller={c} />).lastFrame() ?? "";
    expect(f).not.toContain("Type your task"); // stays in running mode, doesn't flip to the task input
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
    const { stdin, lastFrame, unmount } = render(<App controller={c} fullscreen model="m" coachModel={() => "cc/opus"} />);
    const waitFrame = async (t: string): Promise<void> => {
      for (let i = 0; i < 200 && !clean(lastFrame()).includes(t); i++) await sleep(15);
    };
    const waitState = async (cond: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !cond(); i++) await sleep(15);
    };
    await waitFrame("> ");
    stdin.write("/");
    await waitFrame("/mcp"); // palette opens, windowed around the selection (shortest names first)
    const f = clean(lastFrame());
    expect(f).toContain("/mcp");
    expect(f).toContain("Enter run"); // hint line
    stdin.write("cl"); // filter → only /clear
    // wait for the filter to actually apply (/mcp gone) — "/clear" alone is ambiguous since its
    // description is present in the unfiltered list too.
    for (let i = 0; i < 200 && clean(lastFrame()).includes("/mcp"); i++) await sleep(15);
    expect(clean(lastFrame())).not.toContain("/mcp");
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

  it("InputLine: empty input + Ctrl+C does NOT quit — it arms a 'press again' hint (two-step exit)", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const { stdin, lastFrame, unmount } = render(<InputLine value="" cursor={0} onChange={() => {}} onSubmit={() => {}} />);
    await sleep(50); // let the raw-stdin handler attach
    // First empty Ctrl+C: if it quit, it would call process.exit(0) and kill the test runner — it must NOT.
    stdin.write("\x03");
    for (let i = 0; i < 200 && !strip(lastFrame()).includes("again to exit"); i++) await sleep(15);
    expect(strip(lastFrame())).toContain("press Ctrl+C again to exit"); // armed, not quit
    // Any other key disarms the pending exit (hint disappears).
    stdin.write("x");
    for (let i = 0; i < 200 && strip(lastFrame()).includes("again to exit"); i++) await sleep(15);
    expect(strip(lastFrame())).not.toContain("again to exit");
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

  /**
   * Five implementers running at once wrote their tool calls into one interleaved chat flow, and nothing in
   * it said whose call was whose. The calls belong to the agent; the panel is where that question is answered.
   */
  it("RunningAgents is a titled box naming each agent's role, task and model", () => {
    const agents = [
      { id: "t1", title: "add-login-endpoint", role: "coder", model: "cc/claude-opus-4-8", startedAt: Date.now() - 72_000 },
      { id: "t2", title: "wire-session-store", role: "designer", model: "opencode-go/deepseek-v4-flash", startedAt: Date.now() - 44_000 },
    ];
    const f = strip(render(<RunningAgents agents={agents} cols={90} />).lastFrame());
    expect(f).toContain("Running agents (2)");
    expect(f).toContain("coder");
    expect(f).toContain("add-login-endpoint");
    expect(f).toContain("cc/claude-opus-4-8");
    expect(f).toMatch(/1m 12s/); // live elapsed from startedAt
  });

  it("RunningAgents says how to inspect an agent until one is selected", () => {
    const a = [{ id: "t1", title: "x", model: "m", startedAt: Date.now() }];
    expect(strip(render(<RunningAgents agents={a} cols={80} />).lastFrame())).toContain("↑/↓ to inspect");
    expect(strip(render(<RunningAgents agents={a} cols={80} cursor={0} />).lastFrame())).not.toContain("↑/↓ to inspect");
  });

  it("RunningAgents shows a finished agent's result with a frozen duration", () => {
    const now = Date.now();
    const agents = [
      { id: "t1", title: "team: security", model: "cx/gpt-5.6", startedAt: now - 30_000, status: "REJECT · C:2 M:1 L:0", doneAt: now - 5_000 },
      { id: "t2", title: "team: arch", model: "cc/opus", startedAt: now - 30_000 }, // still running
    ];
    const f = strip(render(<RunningAgents agents={agents} cols={120} />).lastFrame());
    expect(f).toContain("REJECT · C:2 M:1 L:0"); // result stamped on the finished row
    expect(f).toMatch(/25s/); // frozen at doneAt-startedAt (25s), not the full 30s
    expect(f).toContain("✔"); // finished marker (running rows keep the ● bullet)
  });

  it("RunningAgents opens a detail box for the highlighted agent", () => {
    const agents = [
      { id: "t1", title: "add-login-endpoint", role: "coder", model: "cc/opus", startedAt: Date.now() - 5_000,
        promptTokens: 12_300, completionTokens: 4_500, callCount: 41,
        calls: [{ tool: "read_file", target: "src/auth.ts" }, { tool: "shell", target: "npm test", ok: false }] },
      { id: "t2", title: "other", model: "m", startedAt: Date.now() },
    ];
    const f = strip(render(<RunningAgents agents={agents} cols={140} cursor={0} />).lastFrame());
    expect(f).toContain("role");
    expect(f).toContain("coder");
    expect(f).toContain("41 calls");
    expect(f).toContain("↑12.3k ↓4.5k");
    // What it is DOING, not a transcript of its mechanics.
    expect(f).toContain("running the tests");
    expect(f).not.toContain("read_file(src/auth.ts)");
  });

  /** The panel's rows are counted from this, so it must describe exactly what is drawn. */
  it("agentDetail names role, model and what it is doing", () => {
    const lines = agentDetail({ id: "t1", title: "task", role: "coder", model: "m", startedAt: Date.now(),
      calls: [{ tool: "grep", target: "TaskFlowStore" }] });
    expect(lines[0]).toBe("task");
    expect(lines.some((l) => l.includes("role") && l.includes("coder"))).toBe(true);
    expect(lines.some((l) => l.includes("searching for TaskFlowStore"))).toBe(true);
  });

  it("agentDetail says so when there is nothing yet rather than leaving a blank", () => {
    const lines = agentDetail({ id: "t1", title: "task", startedAt: Date.now() });
    expect(lines.some((l) => l.includes("—"))).toBe(true);
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
    const f = strip(render(<App controller={c} fullscreen model="m" coachModel={() => "cc/opus"} />).lastFrame());
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
        listRoles={() => [{ name: "coach", model: "cc/opus", models: ["cc/opus"] }]} />,
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
    const { lastFrame, unmount } = render(<App controller={c} fullscreen model="m" coachModel={() => "cc/opus"} />);
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

  // A one-line label cannot convey "which approach should we build" — the preview panel carries the trade-offs
  // the choice actually turns on, and the note carries the qualifier the options cannot enumerate.
  it("ChoiceInput: shows the focused option's preview and moves it with the cursor", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const opts = [
      { label: "Repository port", description: "swap to a real API in one place", preview: "A) port\n+ one seam\n- more setup" },
      { label: "Direct calls", description: "fastest to write", preview: "B) direct\n+ fastest\n- changes everywhere" },
    ];
    const { stdin, lastFrame, unmount } = render(<ChoiceInput options={opts} multiSelect={false} cols={120} onSubmit={() => {}} />);
    for (let i = 0; i < 200 && !strip(lastFrame()).includes("Repository port"); i++) await sleep(15);
    expect(strip(lastFrame())).toContain("+ one seam");        // the focused option's preview
    expect(strip(lastFrame())).toContain("swap to a real API"); // and its description
    await sleep(50);
    stdin.write("\x1b[B");
    for (let i = 0; i < 200 && !strip(lastFrame()).includes("+ fastest"); i++) await sleep(15);
    expect(strip(lastFrame())).toContain("- changes everywhere");
    unmount();
  });

  it("ChoiceInput: `n` opens a note that rides along with the answer", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let answer: string | undefined;
    const opts = [{ label: "Repository port" }, { label: "Direct calls" }];
    const { stdin, lastFrame, unmount } = render(<ChoiceInput options={opts} multiSelect={false} cols={100} onSubmit={(a) => { answer = a; }} />);
    for (let i = 0; i < 200 && !strip(lastFrame()).includes("press n to add notes"); i++) await sleep(15);
    await sleep(50);
    stdin.write("n"); await sleep(30);
    for (const ch of "keep the old adapter") { stdin.write(ch); await sleep(4); }
    for (let i = 0; i < 200 && !strip(lastFrame()).includes("keep the old adapter"); i++) await sleep(15);
    stdin.write("\r"); await sleep(40); // confirm the note → back to the list
    stdin.write("\r");                   // submit the selection
    for (let i = 0; i < 200 && answer === undefined; i++) await sleep(15);
    expect(answer).toBe("Repository port\n\nNote: keep the old adapter");
    unmount();
  });

  // While typing a note the list keys must be OFF, or "n" and arrows would silently move the selection.
  it("ChoiceInput: typing a note does not move the selection", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let answer: string | undefined;
    const opts = [{ label: "First" }, { label: "Second" }];
    const { stdin, lastFrame, unmount } = render(<ChoiceInput options={opts} multiSelect={false} cols={100} onSubmit={(a) => { answer = a; }} />);
    for (let i = 0; i < 200 && !strip(lastFrame()).includes("First"); i++) await sleep(15);
    await sleep(50);
    stdin.write("n"); await sleep(30);
    for (const ch of "nnn") { stdin.write(ch); await sleep(6); } // would otherwise re-trigger note mode
    stdin.write("\r"); await sleep(40);
    stdin.write("\r");
    for (let i = 0; i < 200 && answer === undefined; i++) await sleep(15);
    expect(answer).toBe("First\n\nNote: nnn");
    unmount();
  });

  it("ChoiceInput: Esc while noting discards the note but keeps the choice", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let answer: string | undefined;
    const opts = [{ label: "Only" }];
    const { stdin, lastFrame, unmount } = render(<ChoiceInput options={opts} multiSelect={false} cols={100} onSubmit={(a) => { answer = a; }} onEscape={() => {}} />);
    for (let i = 0; i < 200 && !strip(lastFrame()).includes("Only"); i++) await sleep(15);
    await sleep(50);
    stdin.write("n"); await sleep(30);
    for (const ch of "oops") { stdin.write(ch); await sleep(5); }
    stdin.write("\x1b"); await sleep(40); // discard the note, stay in the list
    stdin.write("\r");
    for (let i = 0; i < 200 && answer === undefined; i++) await sleep(15);
    expect(answer).toBe("Only"); // the abandoned note is not attached
    unmount();
  });

  it("ChoiceInput: plain string options still work (nothing had to change at the call sites)", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let answer: string | undefined;
    const { stdin, lastFrame, unmount } = render(<ChoiceInput options={["Yes", "No"]} multiSelect={false} cols={70} onSubmit={(a) => { answer = a; }} />);
    for (let i = 0; i < 200 && !strip(lastFrame()).includes("Yes"); i++) await sleep(15);
    await sleep(50);
    stdin.write("\r");
    for (let i = 0; i < 200 && answer === undefined; i++) await sleep(15);
    expect(answer).toBe("Yes");
    unmount();
  });

});

/**
 * A task was seen held at 26 minutes on a 20-minute budget. The budget now ends the attempt, but the row
 * should say something is wrong before it does — the panel is what the user is watching.
 */
describe("a running agent that has been going too long", () => {
  const agent = (ms: number, over: Record<string, unknown> = {}) =>
    [{ id: "t1", title: "Validate npm start", role: "coder", model: "m", startedAt: Date.now() - ms, ...over }];

  it("marks the clock of an agent past the long-running mark", () => {
    const f = strip(render(<RunningAgents agents={agent(LONG_RUNNING_MS + 60_000)} cols={90} />).lastFrame());
    expect(f).toContain("16m");
  });

  it("leaves a normal one alone", () => {
    const f = strip(render(<RunningAgents agents={agent(60_000)} cols={90} />).lastFrame());
    expect(f).toContain("1m 00s");
  });

  /** A finished agent's frozen clock is a record, not a warning — nothing is waiting on it. */
  it("does not warn about an agent that has already reported", () => {
    const rows = agent(LONG_RUNNING_MS + 60_000, { status: "pass", doneAt: Date.now() });
    expect(() => render(<RunningAgents agents={rows} cols={90} />)).not.toThrow();
  });
});

/**
 * The agent panel says WHO is working; this says what it is COSTING. The three questions came from watching
 * real runs from the outside with a script — a tool that cannot answer them about itself makes everyone
 * rediscover them by hand.
 */
describe("RunMonitor", () => {
  const report = (over: Record<string, unknown> = {}) => ({
    stages: [
      { stage: "implementation", seconds: 1200, runs: 4, failed: 1 },
      { stage: "test suite", seconds: 300, runs: 6, failed: 0 },
    ],
    turns: 100, toolCalls: 142, singleToolTurns: 80, promptTokens: 2_800_000, modelSeconds: 600,
    reReads: [{ task: "T036", subject: "path:src/app/core/store/taskflow.store.ts", count: 23 }],
    errors: [{ model: "cx/gpt-5.6", count: 2 }], wroteNothing: [], inFlight: { count: 0, oldestMs: 0, models: [] }, records: 500, ...over,
  });

  it("is a titled box naming each stage with its share", () => {
    const f = strip(render(<RunMonitor report={report()} cols={120} />).lastFrame());
    expect(f).toContain("Running monitors");
    expect(f).toContain("implementation");
    expect(f).toMatch(/20m\s+80%/);
    expect(f).toContain("1 failed");
  });

  it("reports how many turns asked for a single tool", () => {
    const f = strip(render(<RunMonitor report={report()} cols={120} />).lastFrame());
    expect(f).toContain("1.42 tools/turn");
    expect(f).toContain("80% single");
  });

  /** One agent, one file, over and over is the signature of a context-elision loop. */
  it("names the file one agent keeps re-reading", () => {
    const f = strip(render(<RunMonitor report={report()} cols={120} />).lastFrame());
    expect(f).toContain("T036");
    expect(f).toContain("taskflow.store.ts x23");
  });

  it("says it is waiting rather than drawing an empty box", () => {
    const f = strip(render(<RunMonitor report={report({ records: 0 })} cols={120} />).lastFrame());
    expect(f).toContain("waiting for the first records");
  });

  /** The panel's rows are counted from this; the two disagreeing is how Ink paints over the transcript. */
  it("monitorLines describes exactly what is drawn", () => {
    const lines = monitorLines(report());
    expect(lines.some((l) => l.includes("implementation"))).toBe(true);
    expect(lines.some((l) => l.includes("tools/turn"))).toBe(true);
    expect(monitorLines(report({ records: 0 }))).toHaveLength(1);
  });
});

/**
 * The run monitor answers fixed questions about horse-code; a watch answers whatever the user is actually
 * waiting on — the dev server the agents just started, a CI run, a log the app writes. Both are monitors, so
 * both belong in the same panel.
 */
describe("watches in the monitor panel", () => {
  const empty = { records: 0, stages: [], turns: 0, toolCalls: 0, singleToolTurns: 0, promptTokens: 0, modelSeconds: 0, reReads: [], errors: [], wroteNothing: [], inFlight: { count: 0, oldestMs: 0, models: [] } };
  const watch = (over: Partial<WatchStatus> = {}): WatchStatus => ({
    id: 1, name: "tail", command: "tail -f app.log", startedAt: Date.now(), events: 12, suppressed: 0, alive: true, ...over,
  });

  it("counts the live ones in the title", () => {
    const f = strip(render(<RunMonitor report={empty} watches={[watch(), watch({ id: 2, alive: false })]} cols={120} />).lastFrame());
    expect(f).toContain("1 watch(es)");
  });

  /** The last line it printed is the whole reason it was started. */
  it("shows each watch with its latest line", () => {
    const f = strip(render(<RunMonitor report={empty} watches={[watch({ last: "ERROR connection refused" })]} cols={120} />).lastFrame());
    expect(f).toContain("tail");
    expect(f).toContain("12 event(s)");
    expect(f).toContain("ERROR connection refused");
  });

  it("says why a watch is no longer running", () => {
    const f = strip(render(<RunMonitor report={empty} watches={[watch({ alive: false, exit: "exited (1)" })]} cols={120} />).lastFrame());
    expect(f).toContain("exited (1)");
  });

  /** The panel exists for the watches even before any telemetry has landed. */
  it("draws for watches alone, without waiting for telemetry", () => {
    expect(monitorLines(empty, [watch()])).toHaveLength(1);
    expect(monitorLines(empty, [])).toEqual(["waiting for the first records…"]);
  });
});

/**
 * Pressing `/` during a run showed nothing at all: the palette required the idle state, so the commands were
 * still there and still worked, they simply could not be seen or completed. Typing IS allowed during a run —
 * that is what the send-mode picker exists for — so the help for what can be typed has to be as well.
 */
describe("the slash palette while a job is running", () => {
  const running = (): TuiController => {
    const c = new TuiController();
    c.beginRun(); // mode "running" — the state that used to suppress the palette entirely
    return c;
  };

  it("opens for a slash typed mid-run", async () => {
    const { stdin, lastFrame } = render(<App controller={running()} fullscreen />);
    for (let i = 0; i < 300 && !strip(lastFrame()).includes("> "); i++) await new Promise((r) => setTimeout(r, 15));
    stdin.write("/");
    for (let i = 0; i < 300 && !strip(lastFrame()).includes("/mcp"); i++) await new Promise((r) => setTimeout(r, 15));
    expect(strip(lastFrame())).toContain("/mcp");
  });

  it("still opens when nothing is running", async () => {
    const c = new TuiController();
    c.awaitTask();
    const { stdin, lastFrame } = render(<App controller={c} fullscreen />);
    for (let i = 0; i < 200 && !strip(lastFrame()).includes("> "); i++) await new Promise((r) => setTimeout(r, 15));
    stdin.write("/");
    for (let i = 0; i < 200 && !strip(lastFrame()).includes("/mcp"); i++) await new Promise((r) => setTimeout(r, 15));
    expect(strip(lastFrame())).toContain("/mcp");
  });
});
