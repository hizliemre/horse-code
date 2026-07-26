import { describe, it, expect } from "vitest";
import { OmniRouteProvider } from "../../src/providers/omniroute.js";

/**
 * Pressing Ctrl+C benched the model.
 *
 * A cancellation and a dead connection arrive the same way — an aborted fetch — so the abort became a
 * retryable error, the retryable error benched the model, and every role using it was re-assigned. The user
 * stopped the run and was told their model had failed.
 */
describe("a cancelled call is not a model failure", () => {
  const provider = (): OmniRouteProvider =>
    new OmniRouteProvider({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "k" });

  it("reports cancellation, not a retryable fault, when the caller aborts", async () => {
    const ac = new AbortController();
    ac.abort();
    const events = [];
    for await (const ev of provider().chat({ model: "m", messages: [], tools: [] }, ac.signal)) events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "error", message: "cancelled", retryable: false });
  });

  /**
   * The other side of the same test: a connection that fails on its own IS retryable. Making every abort
   * non-retryable would have fixed the benching by breaking the fallback chain.
   */
  it("still reports a genuine connection failure as retryable", async () => {
    const events = [];
    const live = new AbortController();
    for await (const ev of provider().chat({ model: "m", messages: [], tools: [] }, live.signal)) events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", retryable: true });
    expect((events[0] as { message: string }).message).not.toBe("cancelled");
  });
});
