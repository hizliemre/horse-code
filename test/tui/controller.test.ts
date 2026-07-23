import { describe, it, expect } from "vitest";
import { TuiController } from "../../src/tui/controller.js";

describe("TuiController", () => {
  it("onEvent phase → updates state.phase + calls the listener", () => {
    const c = new TuiController();
    let notified = 0;
    c.subscribe(() => { notified++; });
    c.onEvent({ kind: "phase", phase: "waves", detail: "x" });
    expect(c.getState().phase).toBe("waves");
    expect(c.getState().detail).toBe("x");
    expect(notified).toBe(1);
  });

  it("narrates spec-kit authoring phases into the chat flow (deduped), skips non-authoring phases", () => {
    const c = new TuiController();
    c.beginRun();
    c.onEvent({ kind: "phase", phase: "constitution" });
    c.onEvent({ kind: "phase", phase: "constitution" }); // duplicate → not re-narrated
    c.onEvent({ kind: "phase", phase: "specify" });
    c.onEvent({ kind: "phase", phase: "waves" }); // not an authoring phase → no note
    const notes = c.getState().transcript
      .filter((m): m is { role: "user" | "assistant"; text: string } => "role" in m)
      .map((m) => m.text);
    expect(notes.filter((t) => t.toLowerCase().includes("constitution"))).toHaveLength(1); // deduped
    expect(notes.some((t) => t.includes("questions"))).toBe(true); // heads-up that it may ask
    expect(notes.some((t) => t.toLowerCase().includes("spec"))).toBe(true);
    expect(notes).toHaveLength(2); // constitution + specify only (waves not narrated)
  });

  it("onEvent board → updates state.cards", () => {
    const c = new TuiController();
    c.onEvent({ kind: "board", cards: [{ id: "a", title: "A", column: "TODO" }] });
    expect(c.getState().cards).toEqual([{ id: "a", title: "A", column: "TODO" }]);
  });

  it("onEvent refined → replaces the last user message live", () => {
    const c = new TuiController();
    c.awaitTask();
    c.submitTask("raw prompt");
    let notified = 0;
    c.subscribe(() => { notified++; });
    c.onEvent({ kind: "refined", refinedPrompt: "Refined prompt" });
    expect(c.getState().transcript).toEqual([{ role: "user", text: "Refined prompt" }]);
    expect(notified).toBe(1);
  });

  it("onEvent refined → no-op when the last message isn't a user message", () => {
    const c = new TuiController();
    c.endRun("assistant only");
    c.onEvent({ kind: "refined", refinedPrompt: "Refined prompt" });
    expect(c.getState().transcript).toEqual([{ role: "assistant", text: "assistant only" }]);
  });

  it("ask sets pending + notifies; answer resolves the promise + clears pending", async () => {
    const c = new TuiController();
    let notified = 0;
    c.subscribe(() => { notified++; });
    const p = c.ask("Continue?");
    expect(c.getState().pending).toEqual({ question: "Continue?" });
    expect(notified).toBe(1);
    c.answer("yes");
    expect(await p).toBe("yes");
    expect(c.getState().pending).toBeUndefined();
    expect(notified).toBe(2);
  });

  it("getState returns a new reference on mutation (for React re-render)", () => {
    const c = new TuiController();
    const s0 = c.getState();
    c.onEvent({ kind: "phase", phase: "p" });
    expect(c.getState()).not.toBe(s0);
  });

  it("subscribe's return value unsubscribes", () => {
    const c = new TuiController();
    let n = 0;
    const off = c.subscribe(() => { n++; });
    c.onEvent({ kind: "phase", phase: "a" });
    off();
    c.onEvent({ kind: "phase", phase: "b" });
    expect(n).toBe(1);
  });

  it("awaitTask mode=input + notify; submitTask resolves the promise", async () => {
    const c = new TuiController();
    let n = 0; c.subscribe(() => { n++; });
    const p = c.awaitTask();
    expect(c.getState().mode).toBe("input");
    expect(n).toBe(1);
    c.submitTask("a task");
    expect(await p).toBe("a task");
  });

  it("beginRun mode=running + resets board/phase", () => {
    const c = new TuiController();
    c.onEvent({ kind: "board", cards: [{ id: "a", title: "A", column: "TODO" }] });
    c.onEvent({ kind: "phase", phase: "waves" });
    c.beginRun();
    expect(c.getState().mode).toBe("running");
    expect(c.getState().cards).toEqual([]);
    expect(c.getState().phase).toBe("");
  });

  it("submitTask appends the user message to the transcript", async () => {
    const c = new TuiController();
    const p = c.awaitTask();
    c.submitTask("task-1");
    await p;
    expect(c.getState().transcript).toEqual([{ role: "user", text: "task-1" }]);
  });

  it("endRun appends the assistant message + mode=input", () => {
    const c = new TuiController();
    c.endRun("report text");
    expect(c.getState().mode).toBe("input");
    expect(c.getState().transcript).toEqual([{ role: "assistant", text: "report text" }]);
  });

  it("beginRun preserves the transcript (resets the board)", () => {
    const c = new TuiController();
    c.endRun("previous");
    c.beginRun();
    expect(c.getState().transcript).toEqual([{ role: "assistant", text: "previous" }]);
    expect(c.getState().cards).toEqual([]);
  });

  it("one-shot: mode stays undefined if never set (backward compatibility)", () => {
    expect(new TuiController().getState().mode).toBeUndefined();
  });

  it("submitTask while no consumer is waiting → queues instead of appending", () => {
    const c = new TuiController();
    c.submitTask("queued while busy");
    expect(c.getState().queued).toBe(1);
    expect(c.getState().transcript).toEqual([]);
  });

  it("awaitTask drains a queued prompt immediately (append + resolve)", async () => {
    const c = new TuiController();
    c.submitTask("q1"); // queued (nobody awaiting)
    const p = c.awaitTask();
    expect(await p).toBe("q1");
    expect(c.getState().transcript).toEqual([{ role: "user", text: "q1" }]);
    expect(c.getState().queued).toBe(0);
  });

  it("onUsage accumulates turn tokens + tracks the latest active model", () => {
    const c = new TuiController();
    c.beginRun();
    c.onUsage({ model: "m-a", promptTokens: 10, completionTokens: 5 });
    c.onUsage({ model: "m-b", promptTokens: 3, completionTokens: 2 });
    const meta = c.getState().meta!;
    expect(meta.model).toBe("m-b");
    expect(meta.promptTokens).toBe(13);
    expect(meta.completionTokens).toBe(7);
    expect(meta.calls).toBe(2); // each usage event = one LLM call
    expect(meta.running).toBe(true);
  });

  it("beginRun resets meta + starts the clock; endRun freezes duration", () => {
    let t = 1000;
    const c = new TuiController(() => t);
    c.beginRun();
    c.onUsage({ model: "m", promptTokens: 4, completionTokens: 1 });
    t = 3500;
    c.awaitTask(); // simulate the REPL waiting for the next prompt
    c.submitTask("x");
    c.endRun("report");
    const meta = c.getState().meta!;
    expect(meta.running).toBe(false);
    expect(meta.durationMs).toBe(2500);
    expect(meta.promptTokens).toBe(4);
  });

  it("picker: openPicker → setPickerModels → applyModel flow", () => {
    const c = new TuiController();
    c.openPicker();
    expect(c.getState().mode).toBe("picker");
    expect(c.getState().picker).toEqual({ models: [], loading: true, stage: "model" });

    c.setPickerModels(["a/one", "b/two"]);
    expect(c.getState().picker).toEqual({ models: ["a/one", "b/two"], loading: false, stage: "model" });

    c.applyModel("a/one");
    expect(c.getState().mode).toBe("input");
    expect(c.getState().picker).toBeUndefined();
    expect(c.getState().currentModel).toBe("a/one");
  });

  it("role picker: openRolePicker(roles) → chooseRole → setPickerModels → applyRoleModel", () => {
    const c = new TuiController();
    c.openRolePicker(["coach", "coder"]);
    expect(c.getState().mode).toBe("picker");
    expect(c.getState().picker).toEqual({ models: ["coach", "coder"], loading: false, stage: "role" });

    c.chooseRole("coder"); // role chosen → build a 3-model chain for it (App fetches models per slot)
    expect(c.getState().picker).toMatchObject({ models: [], loading: true, stage: "model", role: "coder", picked: [], slots: 3 });

    // slot 1/3 (primary)
    c.setPickerModels(["a/one", "b/two", "c/three"]);
    expect(c.addChainModel("a/one")).toBe(false); // more slots remain
    expect(c.getState().picker).toMatchObject({ picked: ["a/one"], loading: true });
    // slot 2/3 (fallback 1) — App re-fetches excluding a/one
    c.setPickerModels(["b/two", "c/three"]);
    expect(c.addChainModel("b/two")).toBe(false);
    // slot 3/3 (fallback 2)
    c.setPickerModels(["c/three"]);
    expect(c.addChainModel("c/three")).toBe(true); // chain complete → caller applies it

    c.applyRoleModel("coder", ["a/one", "b/two", "c/three"]);
    expect(c.getState().mode).toBe("input");
    expect(c.getState().picker).toBeUndefined();
    const text = (c.getState().transcript.at(-1) as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("`coder`");
    expect(text).toContain("▸ a/one"); // primary
    expect(text).toContain("↳ b/two"); // fallback, stacked
    expect(text).toContain("↳ c/three");
  });

  it("'agents' event → live sub-agents panel (council), empty list clears it", () => {
    const c = new TuiController();
    c.onEvent({ kind: "agents", agents: [
      { id: "council:security", title: "council: security", model: "cc/opus" },
      { id: "council:architecture", title: "council: architecture", model: "cx/gpt-5.6" },
    ] });
    const agents = c.getState().runningAgents;
    expect(agents.map((a) => a.title)).toEqual(["council: security", "council: architecture"]);
    expect(agents[0].model).toBe("cc/opus");
    expect(agents[0].startedAt).toBeTypeOf("number");
    c.onEvent({ kind: "agents", agents: [] }); // council done
    expect(c.getState().runningAgents).toEqual([]);
  });

  it("mode picker: openModePicker → applyMode confirms + closes", () => {
    const c = new TuiController();
    c.openModePicker(["ask", "acceptEdits", "auto"], "Current: acceptEdits");
    expect(c.getState().mode).toBe("picker");
    expect(c.getState().picker).toMatchObject({ models: ["ask", "acceptEdits", "auto"], stage: "mode", note: "Current: acceptEdits" });
    c.applyMode("auto", "auto-approve everything except dangerous commands");
    expect(c.getState().mode).toBe("input");
    expect(c.getState().picker).toBeUndefined();
    expect((c.getState().transcript.at(-1) as { text?: string } | undefined)?.text).toContain("Permission mode → **auto**");
  });

  it("picker: setPickerError + cancelPicker", () => {
    const c = new TuiController();
    c.openPicker();
    c.setPickerError("network down");
    expect(c.getState().picker).toEqual({ models: [], loading: false, error: "network down", stage: "model" });
    c.cancelPicker();
    expect(c.getState().mode).toBe("input");
    expect(c.getState().picker).toBeUndefined();
  });

  it("currentModel starts empty", () => {
    expect(new TuiController().getState().currentModel).toBe("");
  });

  it("pushActivity appends file writes/edits into the chat flow as inline tool items (in order)", () => {
    const c = new TuiController();
    c.awaitTask(); c.submitTask("do X"); c.beginRun();
    c.pushActivity({ tool: "write", target: "spec.md", lines: 42, preview: ["# Spec"] });
    c.pushActivity({ tool: "edit", target: "plan.md", lines: 3 });
    const tool = c.getState().transcript.filter((m) => "kind" in m) as { kind: "tool"; activity: { tool: string; target: string } }[];
    expect(tool.map((m) => [m.activity.tool, m.activity.target])).toEqual([["write", "spec.md"], ["edit", "plan.md"]]);
  });

  it("ask with options sets pending.options + multiSelect (choice question); answer resolves it", async () => {
    const c = new TuiController();
    const p = c.ask("pick principles", { options: ["A", "B", "C"], multiSelect: true });
    expect(c.getState().pending).toEqual({ question: "pick principles", options: ["A", "B", "C"], multiSelect: true });
    c.answer("A; C");
    expect(await p).toBe("A; C");
    expect(c.getState().pending).toBeUndefined();
  });

  it("answer records the Q&A into the chat flow (question as assistant, answer as user; tag stripped)", () => {
    const c = new TuiController();
    void c.ask("[question] What should Section 2 cover?");
    c.answer("Data Storage");
    expect(c.getState().transcript).toEqual([
      { role: "assistant", text: "What should Section 2 cover?" }, // [question] tag stripped
      { role: "user", text: "Data Storage" },
    ]);
    expect(c.getState().pending).toBeUndefined();
  });

  it("board event → runningAgents: IN-PROGRESS cards only, with model + a stable start time", () => {
    let t = 1000;
    const c = new TuiController(() => t);
    c.beginRun();
    c.onEvent({ kind: "board", cards: [
      { id: "t1", title: "add-login", column: "IN-PROGRESS", model: "cc/opus" },
      { id: "t2", title: "wire-store", column: "IN-PROGRESS", model: "go/flash" },
      { id: "t3", title: "docs", column: "TODO" },
    ] });
    const a1 = c.getState().runningAgents;
    expect(a1.map((a) => a.id)).toEqual(["t1", "t2"]); // TODO excluded
    expect(a1.find((a) => a.id === "t1")).toMatchObject({ title: "add-login", model: "cc/opus", startedAt: 1000 });

    t = 5000; // t1 finishes; t2 keeps running
    c.onEvent({ kind: "board", cards: [
      { id: "t1", title: "add-login", column: "DONE", model: "cc/opus" },
      { id: "t2", title: "wire-store", column: "IN-PROGRESS", model: "go/flash" },
    ] });
    const a2 = c.getState().runningAgents;
    expect(a2.map((a) => a.id)).toEqual(["t2"]); // finished agent dropped
    expect(a2[0].startedAt).toBe(1000); // t2's start time is stable across board events (duration keeps counting)
  });

  it("beginRun and endRun clear runningAgents", () => {
    const c = new TuiController();
    c.beginRun();
    c.onEvent({ kind: "board", cards: [{ id: "t1", title: "x", column: "IN-PROGRESS", model: "m" }] });
    expect(c.getState().runningAgents).toHaveLength(1);
    c.endRun("done");
    expect(c.getState().runningAgents).toEqual([]);
  });

  it("note appends an assistant message (used by /help)", () => {
    const c = new TuiController();
    c.endRun("hi");
    c.note("/model — switch\n/exit — quit");
    expect(c.getState().transcript).toEqual([
      { role: "assistant", text: "hi" },
      { role: "assistant", text: "/model — switch\n/exit — quit" },
    ]);
  });

  it("startBusy → running with a live meter; onUsage accumulates; endBusy freezes the metrics", () => {
    const c = new TuiController();
    c.startBusy("tuning", "cc/claude-fable-5");
    expect(c.getState().mode).toBe("running");
    expect(c.getState().phase).toBe("tuning");
    expect(c.getState().meta).toMatchObject({ model: "cc/claude-fable-5", running: true, calls: 0 });
    expect(c.getState().meta?.startedAt).toBeTypeOf("number");
    c.onUsage({ model: "cc/claude-fable-5", promptTokens: 1200, completionTokens: 340 });
    expect(c.getState().meta).toMatchObject({ promptTokens: 1200, completionTokens: 340, calls: 1 });
    c.endBusy();
    expect(c.getState().mode).toBe("input");
    expect(c.getState().meta?.running).toBe(false); // frozen → shows as a done line
    expect(c.getState().meta?.durationMs).toBeTypeOf("number");
  });

  it("streamNote updates one note in place as text is appended", () => {
    const c = new TuiController();
    c.note("header");
    const append = c.streamNote("");
    append("Coach ");
    append("gets sonnet.");
    expect(c.getState().transcript).toEqual([
      { role: "assistant", text: "header" },
      { role: "assistant", text: "Coach gets sonnet." }, // grew in place, not appended as new items
    ]);
  });

  it("streamNote is lazy: no empty bubble until the first delta arrives", () => {
    const c = new TuiController();
    c.note("header");
    const append = c.streamNote(""); // no delta yet → nothing added
    expect(c.getState().transcript).toEqual([{ role: "assistant", text: "header" }]);
    append("first token");
    expect(c.getState().transcript).toEqual([
      { role: "assistant", text: "header" },
      { role: "assistant", text: "first token" },
    ]);
  });

  it("addAttachment stages images (count in state); submit hands them to the turn and clears the count", () => {
    const c = new TuiController();
    c.awaitTask();
    c.addAttachment("data:image/png;base64,AAA");
    c.addAttachment("data:image/png;base64,BBB");
    expect(c.getState().attachments).toBe(2);
    c.submitTask("here it is");
    expect(c.getState().attachments).toBe(0); // staging cleared
    expect(c.takeAttachments()).toEqual(["data:image/png;base64,AAA", "data:image/png;base64,BBB"]);
    expect(c.takeAttachments()).toEqual([]); // drained once
  });

  it("addInboxNote stages by-the-way notes (with a confirmation); takeInboxNote / drainInbox drain them", () => {
    const c = new TuiController();
    c.addInboxNote("also update the docs");
    // a confirmation is shown in the transcript
    expect(c.getState().transcript.some((m) => "role" in m && m.text.includes("also update the docs"))).toBe(true);
    expect(c.takeInboxNote()).toBe("also update the docs");
    expect(c.takeInboxNote()).toBeUndefined();
    c.addInboxNote("x"); c.addInboxNote("y");
    expect(c.drainInbox()).toEqual(["x", "y"]);
    expect(c.takeInboxNote()).toBeUndefined();
  });

  it("clearAttachments discards staged images", () => {
    const c = new TuiController();
    c.addAttachment("data:image/png;base64,AAA");
    c.clearAttachments();
    expect(c.getState().attachments).toBe(0);
  });

  it("a queued submit (while running) does not carry images", () => {
    const c = new TuiController();
    c.addAttachment("data:image/png;base64,AAA");
    c.submitTask("queued while busy"); // no awaitTask consumer → queued
    expect(c.getState().attachments).toBe(0);
    expect(c.takeAttachments()).toEqual([]); // images dropped for queued prompts
  });

  it("messages() returns only conversation messages, excluding inline tool items", () => {
    const c = new TuiController();
    c.awaitTask(); c.submitTask("do X"); c.beginRun();
    c.pushActivity({ tool: "write", target: "spec.md", lines: 1, preview: ["x"] });
    c.endRun("done");
    expect(c.messages()).toEqual([
      { role: "user", text: "do X" },
      { role: "assistant", text: "done" },
    ]);
  });

  it("setNextSteps stores follow-ups; beginRun clears them (stale suggestions gone on a new turn)", () => {
    const c = new TuiController();
    c.setNextSteps(["add a test", "write docs"]);
    expect(c.getState().nextSteps).toEqual(["add a test", "write docs"]);
    c.beginRun();
    expect(c.getState().nextSteps).toEqual([]);
  });

  it("loadTranscript replaces the transcript with a resumed session's messages (used by /resume)", () => {
    const c = new TuiController();
    c.awaitTask(); c.submitTask("stale"); c.beginRun(); c.endRun("stale answer");
    c.loadTranscript([
      { role: "user", text: "earlier prompt" },
      { role: "assistant", text: "earlier reply" },
    ]);
    expect(c.getState().transcript).toEqual([
      { role: "user", text: "earlier prompt" },
      { role: "assistant", text: "earlier reply" },
    ]);
    expect(c.getState().meta).toBeUndefined();
  });

  it("clearTranscript empties the transcript + drops the metrics (used by /clear)", () => {
    let t = 0;
    const c = new TuiController(() => t);
    c.awaitTask(); c.submitTask("q"); c.beginRun();
    c.onUsage({ model: "m", promptTokens: 5, completionTokens: 1 });
    c.endRun("answer");
    expect(c.getState().transcript.length).toBeGreaterThan(0);
    c.clearTranscript();
    expect(c.getState().transcript).toEqual([]);
    expect(c.getState().meta).toBeUndefined();
  });
});
