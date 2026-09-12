import { describe, it, expect } from "vitest";
import { FactBus, renderFor, PER_TURN, PER_READER, MAX_FACT_CHARS } from "../../src/engine/fact-bus.js";

/**
 * Every other channel for sharing context is boundary-synchronous: a trace refreshes after a task merges,
 * memory is injected once at task start and curated at job end, a card's notes reach its own next attempt.
 * So an agent that discovers something at minute two of a twenty-minute task could not tell the seven agents
 * working beside it — and with `maxParallel` at eight, that is where concurrent discovery happens.
 */
describe("what one agent found reaching the others", () => {
  it("delivers a fact to a sibling", () => {
    const bus = new FactBus();
    bus.publish("T001", "the price snapshot is written by SupplierChannelLifecycle, not the handler");
    expect(bus.drain("T002").map((f) => f.text)).toEqual([
      "the price snapshot is written by SupplierChannelLifecycle, not the handler",
    ]);
  });

  /** Its own news is not news. An agent already knows what it just wrote down. */
  it("never tells an agent its own fact", () => {
    const bus = new FactBus();
    bus.publish("T001", "a");
    expect(bus.drain("T001")).toEqual([]);
  });

  /** Once each. A cursor rather than a seen-set, so a long task does not re-read the same note every turn. */
  it("delivers each fact to each reader exactly once", () => {
    const bus = new FactBus();
    bus.publish("T001", "a");
    expect(bus.drain("T002")).toHaveLength(1);
    expect(bus.drain("T002")).toEqual([]);
    // …and a different reader still gets it.
    expect(bus.drain("T003")).toHaveLength(1);
  });

  it("carries facts published while a reader was busy", () => {
    const bus = new FactBus();
    bus.publish("T001", "a");
    bus.drain("T002");
    bus.publish("T001", "b");
    expect(bus.drain("T002").map((f) => f.text)).toEqual(["b"]);
  });
});

/**
 * The bound is the point, not a detail. Injecting into a running conversation is exactly what made mid-task
 * compaction worth a signal — the agent is now reasoning from something it did not read. Eight agents each
 * narrating to the other seven would swell every prompt and sharpen none.
 */
describe("what it refuses to deliver", () => {
  it("hands over at most a couple per turn", () => {
    const bus = new FactBus();
    for (let i = 0; i < 5; i++) bus.publish("T001", `fact ${i}`);
    expect(bus.drain("T002")).toHaveLength(PER_TURN);
  });

  /**
   * And a ceiling across the whole task, because the failure to avoid is cumulative: an agent handed twenty
   * facts is carrying a second conversation however slowly they arrived.
   */
  it("stops entirely once a reader has had its share", () => {
    const bus = new FactBus();
    let handed = 0;
    for (let turn = 0; turn < 20; turn++) {
      bus.publish("T001", `fact ${turn}`);
      handed += bus.drain("T002").length;
    }
    expect(handed).toBe(PER_READER);
  });

  /**
   * The cursor advances past what the budget refused, so a reader at its ceiling is not re-offered the same
   * facts forever — they are dropped, and that is the intended answer.
   */
  it("does not re-offer what it declined to deliver", () => {
    const bus = new FactBus();
    for (let i = 0; i < 4; i++) bus.publish("T001", `fact ${i}`);
    bus.drain("T002");                 // takes 2, passes over the other 2
    bus.publish("T001", "newest");
    expect(bus.drain("T002").map((f) => f.text)).toEqual(["newest"]);
  });

  /** Longer than this is not a fact, it is a document — and a document belongs in a trace. */
  it("ignores something too long to be a fact", () => {
    const bus = new FactBus();
    bus.publish("T001", "x".repeat(MAX_FACT_CHARS + 1));
    bus.publish("T001", "   ");
    expect(bus.drain("T002")).toEqual([]);
    expect(bus.all()).toEqual([]);
  });
});

/**
 * The distinction that keeps this safe. The inbox's other user is a person's correction — an INSTRUCTION —
 * and an agent that cannot tell the two apart will act on a peer's observation as though it were a decision.
 */
describe("how a sibling's fact is worded", () => {
  it("says where it came from and that it is not an instruction", () => {
    const out = renderFor([{ from: "T007", text: "the endpoint returns 409 on a duplicate", seq: 1 }]);
    expect(out).toMatch(/INFORMATION, not an instruction/);
    expect(out).toContain("found by T007");
    expect(out).toContain("the endpoint returns 409 on a duplicate");
  });

  it("says nothing when there is nothing to pass on", () => {
    expect(renderFor([])).toBeUndefined();
  });
});

/**
 * The wiring, asserted on the source because the alternative is standing up a whole wave to watch one note
 * travel. What matters is that BOTH ends are connected: a publisher that nobody reads and a reader nobody
 * publishes to each look exactly like a working channel from the other side.
 */
describe("both ends are actually connected", () => {
  const read = async (p: string): Promise<string> =>
    (await import("node:fs/promises")).readFile(p, "utf8");

  it("an implementer's remembered fact is published to its siblings", async () => {
    const src = await read("src/engine/implementer.ts");
    // The same write does both: durable memory, and the agents in flight beside it.
    expect(src).toContain("deps.rememberFact?.(fact)");
    expect(src).toContain("deps.facts?.publish(task.id, fact)");
  });

  it("an implementer reads its siblings' facts every turn, through the inbox", async () => {
    const src = await read("src/engine/implementer.ts");
    expect(src).toContain("bus.drain(task.id)");
    // A person's correction still comes FIRST: they are watching and they said something now.
    expect(src).toContain("deps.inbox?.() ?? siblingNote() ?? deadlineNote()");
  });

  /**
   * One bus per JOB. Carried into the next job it would hand a fresh wave observations about work that has
   * already merged; what deserves to outlive the job is in durable memory, from the same write.
   */
  it("gives each job its own bus", async () => {
    const src = await read("src/engine/job.ts");
    // Constructed inside the job's own scope and handed to the wave — not shared from the composition root.
    expect(src).toContain("const facts = new FactBus()");
    expect(src).toMatch(/runWaves\(\{ \.\.\.deps[^)]*facts \}/);
  });
});

/**
 * The measurement, because the decision to keep this channel needs evidence and the size of the problem it
 * addresses was never measured. `dropped` is the one to read first: the cursor advances past everything a
 * drain considered, so a fact a reader was too full to take is GONE for that reader rather than deferred.
 * That number is what the bound costs.
 */
describe("what the channel actually did", () => {
  it("counts publishes, handovers and readers", () => {
    const bus = new FactBus();
    bus.publish("T001", "a");
    bus.drain("T002");
    bus.drain("T003");
    expect(bus.stats()).toEqual({ published: 1, refused: 0, delivered: 2, dropped: 0, readers: 2 });
  });

  /** One fact reaching three siblings is three handovers — the cost is per reader, so the count is too. */
  it("counts a handover per reader, not per fact", () => {
    const bus = new FactBus();
    bus.publish("T001", "a");
    for (const r of ["T002", "T003", "T004"]) bus.drain(r);
    expect(bus.stats().delivered).toBe(3);
    expect(bus.stats().published).toBe(1);
  });

  /** What the per-turn bound cost: considered, not taken, and the cursor has moved past it. */
  it("counts what the bound threw away", () => {
    const bus = new FactBus();
    for (let i = 0; i < 5; i++) bus.publish("T001", `fact ${i}`);
    bus.drain("T002"); // takes PER_TURN, loses the rest
    expect(bus.stats().delivered).toBe(PER_TURN);
    expect(bus.stats().dropped).toBe(5 - PER_TURN);
  });

  /** Whether `MAX_FACT_CHARS` is set right shows up here rather than as a silent absence. */
  it("counts what was too long to be a fact", () => {
    const bus = new FactBus();
    bus.publish("T001", "x".repeat(MAX_FACT_CHARS + 1));
    expect(bus.stats()).toMatchObject({ published: 0, refused: 1 });
  });

  /**
   * Zeros are a result. "Nobody published anything" is the most useful single answer this can give, and a
   * silent absence is indistinguishable from telemetry that was never wired up.
   */
  it("reports an untouched channel as zeros rather than nothing", () => {
    expect(new FactBus().stats()).toEqual({ published: 0, refused: 0, delivered: 0, dropped: 0, readers: 0 });
  });

  it("is recorded at the end of a job, zeros included", async () => {
    const src = await (await import("node:fs/promises")).readFile("src/engine/job.ts", "utf8");
    expect(src).toContain('telemetry().event("decision.shared_facts"');
    expect(src).toContain("facts.stats()");
  });
});
