import { describe, it, expect } from "vitest";
import { TuiController } from "../../src/tui/controller.js";
import type { BoardCardView } from "../../src/engine/progress.js";

const inProgress = (over: Partial<BoardCardView> = {}): BoardCardView[] =>
  [{ id: "t1", title: "Define models", column: "IN-PROGRESS", ...over }];

// Every agent row renders from ONE component, but the two kinds of agent feed it through different paths:
// review agents emit their own events, while board-backed implementers are REBUILT from the card list on
// every board change. Anything learned between rebuilds used to be wiped, so their rows showed a bare clock.
describe("board-backed agent rows keep what they learned across board rebuilds", () => {
  it("keeps the running token total when the board changes again", () => {
    const c = new TuiController();
    c.onEvent({ kind: "board", cards: inProgress({ model: "m1" }) });
    c.onEvent({ kind: "agent-usage", id: "t1", promptTokens: 4200, completionTokens: 310 });
    // Any board mutation (a stage append, a note) re-emits the whole card list.
    c.onEvent({ kind: "board", cards: inProgress({ model: "m1" }) });
    const row = c.getState().runningAgents.find((a) => a.id === "t1")!;
    expect(row.promptTokens).toBe(4200);
    expect(row.completionTokens).toBe(310);
  });

  // Observed: two coding rows showed no model at all while their siblings did.
  it("keeps the model when a later card snapshot arrives without one", () => {
    const c = new TuiController();
    c.onEvent({ kind: "board", cards: inProgress({ model: "cc/claude-opus-4-8" }) });
    c.onEvent({ kind: "board", cards: inProgress() }); // no model on this snapshot
    expect(c.getState().runningAgents[0].model).toBe("cc/claude-opus-4-8");
  });

  it("a chain slide renames a board-backed row too, and survives the next rebuild", () => {
    const c = new TuiController();
    c.onEvent({ kind: "board", cards: inProgress({ model: "primary" }) });
    c.onEvent({ kind: "agent-model", id: "t1", model: "fallback-1" });
    expect(c.getState().runningAgents[0].model).toBe("fallback-1");
    c.onEvent({ kind: "board", cards: inProgress() });
    expect(c.getState().runningAgents[0].model).toBe("fallback-1");
  });

  it("a fresh card snapshot still wins when it names a model", () => {
    const c = new TuiController();
    c.onEvent({ kind: "board", cards: inProgress({ model: "m1" }) });
    c.onEvent({ kind: "board", cards: inProgress({ model: "m2" }) }); // escalated to a senior role
    expect(c.getState().runningAgents[0].model).toBe("m2");
  });
});
