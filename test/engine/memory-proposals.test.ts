import { describe, it, expect } from "vitest";
import { ProposalQueue, MAX_PROPOSALS, MAX_PROPOSAL_CHARS } from "../../src/engine/memory-proposals.js";
import { proposeMemoryTool } from "../../src/tools/propose-memory.js";

const ctx = (proposeMemory?: (t: string, k: "fact" | "lesson") => boolean) =>
  ({ cwd: "/tmp", signal: new AbortController().signal, ...(proposeMemory ? { proposeMemory } : {}) });

describe("ProposalQueue", () => {
  it("keeps a proposal with its kind and provenance", () => {
    const q = new ProposalQueue();
    expect(q.add("migrations run on boot", "fact", "code-correctness")).toBe(true);
    expect(q.list()).toEqual([{ text: "migrations run on boot", kind: "fact", proposedBy: "code-correctness" }]);
  });

  // Five lenses noticing the same thing is one signal, not five — and the curator pays per proposal.
  it("collapses the same claim proposed by different agents", () => {
    const q = new ProposalQueue();
    expect(q.add("Use pnpm, not npm!", "fact", "code-conventions")).toBe(true);
    expect(q.add("use pnpm  not npm", "fact", "code-dependencies")).toBe(false);
    expect(q.size()).toBe(1);
  });

  it("rejects empty text", () => {
    expect(new ProposalQueue().add("   ", "fact", "x")).toBe(false);
  });

  it("truncates an essay rather than passing it on", () => {
    const q = new ProposalQueue();
    q.add("x".repeat(5000), "fact", "x");
    expect(q.list()[0].text.length).toBe(MAX_PROPOSAL_CHARS);
  });

  // Fifteen lenses across several rounds could otherwise bury the curator in hundreds of proposals.
  it("caps the queue and counts what it refused", () => {
    const q = new ProposalQueue();
    for (let i = 0; i < MAX_PROPOSALS + 5; i++) q.add(`claim number ${i}`, "fact", "x");
    expect(q.size()).toBe(MAX_PROPOSALS);
    expect(q.overflow()).toBe(5); // refusals are counted, never silent
  });

  it("drain empties the queue so a second job starts clean", () => {
    const q = new ProposalQueue();
    q.add("a claim", "fact", "x");
    expect(q.drain()).toHaveLength(1);
    expect(q.size()).toBe(0);
    expect(q.list()).toEqual([]);
    // …and the dedup memory resets with it, so the same claim can be re-proposed in the next job.
    expect(q.add("a claim", "fact", "x")).toBe(true);
  });
});

describe("propose_memory tool", () => {
  it("queues the proposal and says it may be rewritten or dropped", async () => {
    const seen: [string, string][] = [];
    const r = await proposeMemoryTool.run({ text: "the API base is /v2", kind: "lesson" }, ctx((t, k) => { seen.push([t, k]); return true; }));
    expect(seen).toEqual([["the API base is /v2", "lesson"]]);
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/rewritten or discarded/i);
  });

  it("defaults to a fact", async () => {
    const seen: string[] = [];
    await proposeMemoryTool.run({ text: "x" }, ctx((_t, k) => { seen.push(k); return true; }));
    expect(seen).toEqual(["fact"]);
  });

  it("tells the agent not to retry when the proposal was refused", async () => {
    const r = await proposeMemoryTool.run({ text: "x" }, ctx(() => false));
    expect(r.isError).toBe(false); // a refused duplicate is not an error the agent should react to
    expect(r.content).toMatch(/no action needed/i);
  });

  // Two independent gates: even with the tool registered, a context without the sink stores nothing.
  it("is inert when no proposal sink is wired", async () => {
    const r = await proposeMemoryTool.run({ text: "x" }, ctx());
    expect(r.isError).toBe(true);
  });

  it("rejects malformed and empty input", async () => {
    expect((await proposeMemoryTool.run({}, ctx(() => true))).isError).toBe(true);
    expect((await proposeMemoryTool.run({ text: "  " }, ctx(() => true))).isError).toBe(true);
  });

  // The failure mode to design against is a lens logging its current finding as if it were lasting truth.
  it("its description steers agents away from run-specific noise", () => {
    expect(proposeMemoryTool.description).toMatch(/NOT stored directly/);
    expect(proposeMemoryTool.description).toMatch(/NEVER propose your findings/);
    expect(proposeMemoryTool.description).toMatch(/propose nothing at all/);
  });

  it("is safe — it writes nothing to the repo", () => {
    expect(proposeMemoryTool.permissionLevel).toBe("safe");
  });
});
