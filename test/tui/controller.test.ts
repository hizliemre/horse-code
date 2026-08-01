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

  it("onEvent agent-result → stamps the result (+doneAt) on the matching agent row only", () => {
    const c = new TuiController();
    c.onEvent({ kind: "agents", agents: [
      { id: "team:security", title: "team: security", model: "m1" },
      { id: "team:arch", title: "team: arch", model: "m2" },
    ] });
    c.onEvent({ kind: "agent-result", id: "team:security", status: "REJECT · C:1 M:0 L:2", promptTokens: 8000, completionTokens: 1200 });
    const byId = Object.fromEntries(c.getState().runningAgents.map((a) => [a.id, a]));
    expect(byId["team:security"].status).toBe("REJECT · C:1 M:0 L:2");
    expect(byId["team:security"].doneAt).toBeGreaterThan(0); // timer frozen
    expect(byId["team:security"].promptTokens).toBe(8000); // this agent's token spend
    expect(byId["team:security"].completionTokens).toBe(1200);
    expect(byId["team:arch"].status).toBeUndefined(); // the other row is untouched (still running)
  });

  // A row that shows only a ticking clock for minutes says nothing about what it is costing WHILE it costs it.
  it("onEvent agent-usage → updates the running total without ending the row", () => {
    const c = new TuiController();
    c.onEvent({ kind: "agents", agents: [
      { id: "team:security", title: "team: security", model: "m1" },
      { id: "team:arch", title: "team: arch", model: "m2" },
    ] });
    c.onEvent({ kind: "agent-usage", id: "team:security", promptTokens: 4000, completionTokens: 300 });
    let byId = Object.fromEntries(c.getState().runningAgents.map((a) => [a.id, a]));
    expect(byId["team:security"].promptTokens).toBe(4000);
    expect(byId["team:security"].status).toBeUndefined(); // still running…
    expect(byId["team:security"].doneAt).toBeUndefined(); // …and its timer keeps ticking
    expect(byId["team:arch"].promptTokens).toBeUndefined(); // other rows untouched

    // Later calls replace the total (the emitter sends a cumulative figure, not a delta).
    c.onEvent({ kind: "agent-usage", id: "team:security", promptTokens: 9500, completionTokens: 800 });
    byId = Object.fromEntries(c.getState().runningAgents.map((a) => [a.id, a]));
    expect(byId["team:security"].promptTokens).toBe(9500);
    expect(byId["team:security"].completionTokens).toBe(800);
  });

  // A row showed the chain HEAD forever, so once an agent slid down its fallback chain the panel kept naming
  // a model that was no longer doing the work.
  it("onEvent agent-model → the row names whichever model is actually serving it", () => {
    const c = new TuiController();
    c.onEvent({ kind: "agents", agents: [
      { id: "team:security", title: "team: security", model: "primary" },
      { id: "team:arch", title: "team: arch", model: "primary" },
    ] });
    c.onEvent({ kind: "agent-model", id: "team:security", model: "fallback-1" });
    const byId = Object.fromEntries(c.getState().runningAgents.map((a) => [a.id, a]));
    expect(byId["team:security"].model).toBe("fallback-1");
    expect(byId["team:security"].status).toBeUndefined(); // still running — a rename is not a result
    expect(byId["team:arch"].model).toBe("primary");      // other rows untouched
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

  it("onUsage ignores stray samples after the turn ends (aborted parallel work can't inflate the done line)", () => {
    const c = new TuiController();
    c.beginRun();
    c.onUsage({ model: "m", promptTokens: 100, completionTokens: 50 });
    c.endRun("report"); // turn done → meta.running = false
    const before = c.getState().meta!;
    c.onUsage({ model: "m", promptTokens: 999, completionTokens: 999 }); // late sample from a winding-down councilor
    const after = c.getState().meta!;
    expect(after.promptTokens).toBe(before.promptTokens); // unchanged
    expect(after.completionTokens).toBe(before.completionTokens);
    expect(after.calls).toBe(before.calls);
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
    expect(text).toContain("`coder` → a/one"); // primary, inline after the arrow
    expect(text).toContain("↳ b/two"); // fallbacks side by side on the same line
    expect(text).toContain("↳ c/three");
    expect(text).not.toContain("\n"); // single line (side by side, not stacked)
  });

  it("setLiveActivity shows a transient line; a real tool activity clears it", () => {
    const c = new TuiController();
    c.setLiveActivity("writing constitution.md · 1.2k chars");
    expect(c.getState().liveActivity).toBe("writing constitution.md · 1.2k chars");
    c.pushActivity({ kind: "write", path: "constitution.md", lines: 42 } as never); // tool ran → clears live line
    expect(c.getState().liveActivity).toBeUndefined();
    c.setLiveActivity(""); // empty clears
    expect(c.getState().liveActivity).toBeUndefined();
  });

  it("'note' event → appends a live transcript line (council/judge narration)", () => {
    const c = new TuiController();
    c.onEvent({ kind: "note", text: "● `security` reviewed — ✓ no concerns" });
    c.onEvent({ kind: "note", text: "⚖️ **Judge** → **pass**" });
    expect(c.getState().transcript).toEqual([
      { role: "assistant", text: "● `security` reviewed — ✓ no concerns" },
      { role: "assistant", text: "⚖️ **Judge** → **pass**" },
    ]);
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

  /**
   * The note was queued unconditionally and announced as "folded into the running turn".
   *
   * Only the coach reads the inbox, and the coach is not running during a coding phase — so the question sat
   * there for the rest of the job while the message promised otherwise. A real run: two hours of output, no
   * answer.
   */
  describe("a by-the-way question asked mid-run", () => {
    it("is answered on the spot when an answerer is supplied", () => {
      const c = new TuiController();
      const asked: string[] = [];
      c.addInboxNote("how many tasks are left?", (q) => asked.push(q));
      expect(asked).toEqual(["how many tasks are left?"]);
      expect(c.takeInboxNote()).toBeUndefined(); // not also queued — it would be answered twice
    });

    // The old message was a promise nothing kept. Whichever path is taken, the wording has to match it.
    it("does not claim it was folded into a turn that will answer it", () => {
      const c = new TuiController();
      c.addInboxNote("q", () => {});
      const said = c.getState().transcript.filter((m) => "role" in m).map((m) => (m as { text: string }).text).join("\n");
      expect(said).toContain("q");
      expect(said).not.toContain("folded into the running turn");
    });

    it("still queues, and still says so, when there is no answerer", () => {
      const c = new TuiController();
      c.addInboxNote("q");
      expect(c.takeInboxNote()).toBe("q");
      const said = c.getState().transcript.filter((m) => "role" in m).map((m) => (m as { text: string }).text).join("\n");
      expect(said).toContain("folded into the running turn");
    });
  });

  /**
   * The answer belongs in the CHAT, like every other answer.
   *
   * It was pinned above the input for a while so it could not scroll away. That panel drew raw text — no
   * markdown, and a model that emits its own `<think>` tags leaked them onto the screen — and it held one
   * answer, so a second question erased the first. In the transcript it renders like everything else, it
   * stays, and the newest is at the bottom where the eye already is.
   */
  describe("a by-the-way answer goes into the transcript", () => {
    const said = (c: TuiController): string[] =>
      c.getState().transcript.filter((m) => "role" in m).map((m) => (m as { text: string }).text);

    it("writes the answer as an assistant message", () => {
      const c = new TuiController();
      c.addInboxNote("q", () => {});
      c.liveNote()("59 in TODO");
      expect(said(c)).toContain("59 in TODO");
    });

    /** Rewritten as it grows, so text that has to be cleaned mid-stream never appears half-cleaned. */
    it("replaces the same message as the text grows, rather than appending", () => {
      const c = new TuiController();
      const show = c.liveNote();
      show("59 in");
      show("59 in TODO, 5 running");
      expect(said(c)).toEqual(["59 in TODO, 5 running"]);
    });

    it("leaves no empty message when nothing ever arrives", () => {
      const c = new TuiController();
      c.liveNote();
      expect(said(c)).toEqual([]);
    });

    /** Two questions are two answers — the second must not erase the first. */
    it("keeps an earlier answer when a second question is asked", () => {
      const c = new TuiController();
      c.addInboxNote("first", () => {});
      c.liveNote()("the first answer");
      c.addInboxNote("second", () => {});
      c.liveNote()("the second answer");
      expect(said(c).filter((t) => t.includes("answer"))).toEqual(["the first answer", "the second answer"]);
    });
  });

  /**
   * The answer is only as good as what it is given, and a mid-run question is almost always about progress:
   * how much of the board is done, what is running, what just happened.
   */
  describe("liveSnapshot", () => {
    it("counts the board by column — the question is usually 'how many are left'", () => {
      const c = new TuiController();
      c.onEvent({ kind: "board", cards: [
        { id: "a", title: "A", column: "DONE" },
        { id: "b", title: "B", column: "DONE" },
        { id: "c", title: "C", column: "TODO" },
      ] });
      const snap = c.liveSnapshot();
      expect(snap).toContain("DONE: 2");
      expect(snap).toContain("TODO: 1");
    });

    it("names the agents in flight and the phase", () => {
      const c = new TuiController();
      c.onEvent({ kind: "phase", phase: "waves" });
      c.onEvent({ kind: "agents", agents: [{ id: "coder:1", title: "coder: store", model: "m1" }] });
      const snap = c.liveSnapshot();
      expect(snap).toContain("waves");
      expect(snap).toContain("coder: store");
      expect(snap).toContain("m1");
    });

    it("carries recent activity, so 'what is it doing' has an answer", () => {
      const c = new TuiController();
      c.pushActivity({ tool: "write_file", target: "src/todo.ts", lines: 40 });
      expect(c.liveSnapshot()).toContain("src/todo.ts");
    });

    /** Asked before anything starts, it must still be a usable prompt rather than a wall of blanks. */
    it("reads sensibly with nothing running yet", () => {
      const snap = new TuiController().liveSnapshot();
      expect(snap).toContain("no board yet");
      expect(snap).toContain("- none");
    });
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

/**
 * Five implementers ran at once and wrote their tool calls into ONE chat flow.
 *
 * Nothing in it said whose call was whose, and a single wave produced over a thousand of them — the
 * conversation became a log nobody could read, and the feedback that mattered (who picked up what, who
 * finished) was buried in it. Attributed calls belong to the agent's row.
 */
describe("an agent's tool calls stay on its own row", () => {
  const withAgent = (): TuiController => {
    const c = new TuiController();
    c.onEvent({ kind: "agents", agents: [{ id: "t1", title: "task one", model: "m" }] });
    return c;
  };

  it("keeps an attributed call out of the conversation", () => {
    const c = withAgent();
    c.pushActivity({ agent: "t1", tool: "read_file", target: "src/a.ts", lines: 0, summary: "x" });
    expect(c.getState().transcript.filter((m) => "kind" in m)).toEqual([]);
    expect(c.getState().runningAgents[0].calls).toEqual([{ tool: "read_file", target: "src/a.ts" }]);
  });

  it("counts every call even though it keeps only the last few", () => {
    const c = withAgent();
    for (let i = 0; i < 20; i++) c.pushActivity({ agent: "t1", tool: "read_file", target: `f${i}.ts`, lines: 0, summary: "" });
    const a = c.getState().runningAgents[0];
    expect(a.callCount).toBe(20);
    expect(a.calls!.length).toBeLessThanOrEqual(8);
    expect(a.calls![a.calls!.length - 1].target).toBe("f19.ts"); // newest last
  });

  it("does not repeat an identical call as a second row", () => {
    const c = withAgent();
    c.pushActivity({ agent: "t1", tool: "grep", target: "x", lines: 0, summary: "" });
    c.pushActivity({ agent: "t1", tool: "grep", target: "x", lines: 0, summary: "" });
    expect(c.getState().runningAgents[0].calls).toHaveLength(1);
    expect(c.getState().runningAgents[0].callCount).toBe(2);
  });

  it("marks a call that failed", () => {
    const c = withAgent();
    c.pushActivity({ agent: "t1", tool: "shell", target: "npm test", lines: 0, summary: "", ok: false });
    expect(c.getState().runningAgents[0].calls![0].ok).toBe(false);
  });

  /** A direct question's work SHOULD be visible: there is no agent row to file it under, and no flood. */
  it("still shows the coach's own calls in the conversation", () => {
    const c = withAgent();
    c.pushActivity({ tool: "read_file", target: "README.md", lines: 0, summary: "x" });
    expect(c.getState().transcript.filter((m) => "kind" in m)).toHaveLength(1);
  });

  it("shows a call attributed to an agent that is no longer running, rather than losing it", () => {
    const c = new TuiController();
    c.pushActivity({ agent: "gone", tool: "grep", target: "x", lines: 0, summary: "" });
    expect(c.getState().transcript.filter((m) => "kind" in m)).toHaveLength(1);
  });

  it("survives the row being rebuilt from a board event", () => {
    const c = new TuiController();
    c.onEvent({ kind: "board", cards: [{ id: "t1", title: "task one", column: "IN-PROGRESS", role: "coder" }] });
    c.pushActivity({ agent: "t1", tool: "grep", target: "x", lines: 0, summary: "" });
    c.onEvent({ kind: "board", cards: [{ id: "t1", title: "task one", column: "IN-PROGRESS", role: "coder", model: "m" }] });
    expect(c.getState().runningAgents[0].calls).toHaveLength(1);
    expect(c.getState().runningAgents[0].role).toBe("coder");
  });
});

/**
 * Enter on an empty input queued an empty prompt, and while a job runs nothing consumes the queue — so the
 * counter just climbed. Pressing Enter while reading the agent panel ran it to seventeen, every one of which
 * would have started a turn on "" once the job ended.
 */
describe("a blank line is not a task", () => {
  it("does not queue an empty submit while a job is running", () => {
    const c = new TuiController();
    c.submitTask("");
    c.submitTask("   ");
    c.submitTask("\n");
    expect(c.getState().queued).toBe(0);
  });

  it("does not resolve a waiting turn with an empty prompt", async () => {
    const c = new TuiController();
    let resolved: string | undefined;
    void c.awaitTask().then((t) => { resolved = t; });
    c.submitTask("");
    await Promise.resolve();
    expect(resolved).toBeUndefined();
    expect(c.getState().transcript).toEqual([]);
  });

  it("still takes a real one", () => {
    const c = new TuiController();
    c.submitTask("do the thing");
    expect(c.getState().queued).toBe(1);
  });
});

describe("selecting an agent to inspect", () => {
  const three = (): TuiController => {
    const c = new TuiController();
    c.onEvent({ kind: "agents", agents: [
      { id: "a", title: "A", model: "m" }, { id: "b", title: "B", model: "m" }, { id: "c", title: "C", model: "m" },
    ] });
    return c;
  };

  it("starts with nothing selected — the panel is a list until asked", () => {
    expect(three().getState().agentCursor).toBeUndefined();
  });

  it("↓ from nothing lands on the first, ↑ from nothing on the last", () => {
    const a = three(); a.selectAgent(1);
    expect(a.getState().agentCursor).toBe(0);
    const b = three(); b.selectAgent(-1);
    expect(b.getState().agentCursor).toBe(2);
  });

  /** The list changes under the cursor as agents start and finish; wrapping would jump somewhere unlooked-at. */
  it("clamps at both ends instead of wrapping", () => {
    const c = three();
    c.selectAgent(1); c.selectAgent(-1); c.selectAgent(-1);
    expect(c.getState().agentCursor).toBe(0);
    c.selectAgent(1); c.selectAgent(1); c.selectAgent(1); c.selectAgent(1);
    expect(c.getState().agentCursor).toBe(2);
  });

  it("clears the selection when the panel empties", () => {
    const c = three();
    c.selectAgent(1);
    c.onEvent({ kind: "agents", agents: [] });
    c.selectAgent(1);
    expect(c.getState().agentCursor).toBeUndefined();
  });

  it("clearAgentSelection drops it", () => {
    const c = three();
    c.selectAgent(1);
    c.clearAgentSelection();
    expect(c.getState().agentCursor).toBeUndefined();
  });
});

/**
 * Suggestions used to be drawn in a fixed strip BELOW the input: outside the transcript, dropped whenever
 * the frame ran short of rows, and pushing the input away from the last thing said. They are part of the
 * answer, so they belong in the conversation.
 */
describe("suggested next steps live in the transcript", () => {
  it("appends them as a note, and keeps them for /next", () => {
    const c = new TuiController();
    c.setNextSteps(["Pick a bug to work on", "Verify a remembered note"]);
    const last = c.getState().transcript.at(-1)!;
    expect("text" in last && last.text).toContain("Suggested next steps");
    expect("text" in last && last.text).toContain("1. Pick a bug to work on");
    expect(c.getState().nextSteps).toHaveLength(2); // /next N still resolves against them
  });

  it("does not repeat the same set down the transcript", () => {
    const c = new TuiController();
    c.setNextSteps(["one"]);
    const n = c.getState().transcript.length;
    c.setNextSteps(["one"]);
    expect(c.getState().transcript).toHaveLength(n);
  });

  it("says nothing when the suggestions are cleared", () => {
    const c = new TuiController();
    c.setNextSteps([]);
    expect(c.getState().transcript).toHaveLength(0);
  });
});

describe("busyDetail — the shimmer has to keep saying something new", () => {
  it("updates the detail without disturbing the timer or the token counts", () => {
    const c = new TuiController();
    c.startBusy("tracing", "cc/claude-opus-5");
    const before = c.getState().meta;
    c.busyDetail("143/2030 · OrderService.cs");
    expect(c.getState().detail).toBe("143/2030 · OrderService.cs");
    expect(c.getState().meta).toEqual(before);
    expect(c.getState().mode).toBe("running");
  });

  it("is ignored when nothing is running — a stale detail under an idle prompt reads as a live job", () => {
    const c = new TuiController();
    c.busyDetail("143/2030");
    expect(c.getState().detail).toBeUndefined();
  });
});
