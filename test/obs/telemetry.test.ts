import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Telemetry, NO_TELEMETRY, setTelemetry, telemetry, writeHeapSnapshot, estimateFreezeSeconds, clearPerfMarks } from "../../src/obs/telemetry.js";
import type { SpanRecord, EventRecord } from "../../src/obs/telemetry.js";
import { MemorySink, FileSink } from "../../src/obs/sink.js";

const spans = (s: MemorySink): SpanRecord[] => s.records.filter((r): r is SpanRecord => r.kind !== "event");
const events = (s: MemorySink): EventRecord[] => s.records.filter((r): r is EventRecord => r.kind === "event");

/**
 * Every "why was that slow / why did that fail" question in this project was answered by reading a board file
 * and counting outcomes — blind to how long one model call took, what a tool returned, or which deterministic
 * branch was chosen. The shape here is OpenTelemetry's so the log can be read by tools built for it.
 */
describe("Telemetry", () => {
  it("records a span with its duration and an ok status", async () => {
    const sink = new MemorySink();
    let t = 0;
    const tel = new Telemetry(sink, () => t);
    await tel.span("stage.implementation", { "hc.role": "coder" }, async () => { t += 4_000; });
    expect(spans(sink)).toHaveLength(1);
    expect(spans(sink)[0]).toMatchObject({
      name: "stage.implementation", status: "ok", durationMs: 4_000,
      attributes: { "hc.role": "coder" },
    });
  });

  /** A stage that dies after twenty minutes is the most interesting row in the log. */
  it("records a span that threw, with the reason, and re-throws", async () => {
    const sink = new MemorySink();
    const tel = new Telemetry(sink);
    await expect(tel.span("stage.implementation", {}, async () => { throw new Error("past its budget"); }))
      .rejects.toThrow("past its budget");
    expect(spans(sink)[0].status).toBe("error");
    expect(spans(sink)[0].error).toContain("past its budget");
  });

  /**
   * The parent is found through async context, not through an argument — instrumenting four chokepoints has
   * to yield a whole tree, or every new call site becomes a place to forget the plumbing.
   */
  it("nests a child span under whatever it ran inside", async () => {
    const sink = new MemorySink();
    const tel = new Telemetry(sink);
    await tel.span("stage.code_review", {}, async () => {
      await tel.span("tool.read_file", {}, async () => undefined);
    });
    const [child, parent] = spans(sink); // the child finishes first, so it is written first
    expect(child.name).toBe("tool.read_file");
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(child.traceId).toBe(parent.traceId);
  });

  it("starts a new trace for work that runs under nothing", async () => {
    const sink = new MemorySink();
    const tel = new Telemetry(sink);
    await tel.span("a", {}, async () => undefined);
    await tel.span("b", {}, async () => undefined);
    const [a, b] = spans(sink);
    expect(a.traceId).not.toBe(b.traceId);
    expect(a.parentSpanId).toBeUndefined();
  });

  /** `hc.*` says WHOSE work this is and is true all the way down; a token count is true of one span only. */
  it("passes hc.* attributes down to children and nothing else", async () => {
    const sink = new MemorySink();
    const tel = new Telemetry(sink);
    await tel.span("stage.implementation", { "hc.task.id": "T032", "gen_ai.usage.input_tokens": 5 }, async () => {
      await tel.span("tool.grep", {}, async () => undefined);
    });
    const child = spans(sink).find((s) => s.name === "tool.grep")!;
    expect(child.attributes["hc.task.id"]).toBe("T032");
    expect(child.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
  });

  it("records an event with the trace it happened in", async () => {
    const sink = new MemorySink();
    const tel = new Telemetry(sink);
    await tel.span("stage.code_review", { "hc.task.id": "T1" }, async () => {
      tel.event("decision.review_scale", { "hc.lenses": 4 });
    });
    const e = events(sink)[0];
    expect(e.attributes).toMatchObject({ "hc.lenses": 4, "hc.task.id": "T1" });
    expect(e.traceId).toBe(spans(sink)[0].traceId);
  });

  it("drops attributes that were never set, rather than writing nulls", async () => {
    const sink = new MemorySink();
    const tel = new Telemetry(sink);
    tel.event("gen_ai.chat", { "gen_ai.usage.input_tokens": undefined, "gen_ai.request.model": "m" });
    expect(Object.keys(events(sink)[0].attributes)).toEqual(["gen_ai.request.model"]);
  });

  /** Off unless something deliberately turns it on: a test or a library consumer records nothing. */
  it("is silent by default", async () => {
    expect(telemetry()).toBe(NO_TELEMETRY);
    await expect(NO_TELEMETRY.span("x", {}, async () => 7)).resolves.toBe(7);
  });

  it("can be turned on and off for the process", async () => {
    const sink = new MemorySink();
    setTelemetry(new Telemetry(sink));
    try {
      telemetry().event("x");
      expect(sink.records).toHaveLength(1);
    } finally {
      setTelemetry(NO_TELEMETRY);
    }
  });
});

/**
 * A path that cannot become a directory anywhere, for any user: one component of it is a regular file.
 *
 * The unwritable-path tests used to aim at `/proc`, which is not a fact about the filesystem so much as a
 * fact about Linux — absent on macOS, real and privileged on the runner, and therefore a different code path
 * on each. `mkdir` on a path THROUGH a file fails with ENOTDIR on every platform and is not waived for root,
 * which is what a test about "cannot write here" actually needs.
 */
const blockedPath = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "hc-blocked-"));
  const file = join(dir, "not-a-directory");
  await writeFile(file, "");
  return join(file, "logs");
};

describe("FileSink", () => {
  it("writes one JSON object per line, which is what Loki and jq read unchanged", async () => {
    const home = await mkdtemp(join(tmpdir(), "hc-tel-"));
    try {
      const sink = new FileSink(home, "run-1");
      const tel = new Telemetry(sink);
      await tel.span("stage.implementation", { "hc.task.id": "T1" }, async () => undefined);
      tel.event("decision.route", { "hc.role": "coder" });
      await sink.flush();
      const lines = (await readFile(sink.path, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(2);
      const parsed = lines.map((l) => JSON.parse(l) as { name: string });
      expect(parsed.map((p) => p.name)).toEqual(["stage.implementation", "decision.route"]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  /** An observer that can fail the thing it observes is worse than no observer. */
  it("never raises when the directory cannot even be created", async () => {
    const sink = new FileSink(await blockedPath(), "run-1");
    const tel = new Telemetry(sink);
    await expect(tel.span("x", {}, async () => 1)).resolves.toBe(1);
    await expect(sink.flush()).resolves.toBeUndefined();
  });

  /**
   * The half of the failure `/proc` never reached: `mkdir` succeeds and the OPEN is what fails.
   *
   * `createWriteStream` does not throw for an unopenable path — it emits `error` on a later tick, so the
   * constructor's catch does not run and `stream` is set. Reproduced here by making the log path an existing
   * DIRECTORY: the parent is created, the open fails asynchronously with EISDIR, and `flush()` is called in
   * the same tick as the constructor, before any error handler could have cleared the field.
   *
   * What this asserts is what matters and all that is claimed: the run gets its flush back. It is NOT a
   * regression test for a hang — removing `flush`'s error listener was tried here and this still passes, so
   * on this runtime `end(cb)` does call back on a stream whose open failed. That listener is a cheap second
   * exit, not a fix for a failure anyone has reproduced.
   */
  it("resolves flush when the stream fails to open on a later tick", async () => {
    const home = await mkdtemp(join(tmpdir(), "hc-tel-"));
    try {
      await mkdir(join(home, ".horsecode", "telemetry", "run-1.jsonl"), { recursive: true });
      const sink = new FileSink(home, "run-1");
      sink.write({ kind: "event", name: "x", attributes: {}, at: 0 } as never);
      await expect(sink.flush()).resolves.toBeUndefined();
    } finally { await rm(home, { recursive: true, force: true }); }
  }, 10_000);
});

/**
 * Three heap deaths were each diagnosed from a stack trace and a guess. The sampling added afterwards proved
 * a real rise — the post-GC floor climbing past 1.5 GB in a working run — without saying WHAT was retained.
 * A stack trace names the last allocation; a curve names the shape; only a snapshot names the objects.
 */
describe("writeHeapSnapshot", () => {
  /**
   * These two take a REAL snapshot, and they run everywhere — the skip that was here has been withdrawn.
   *
   * It was added on suspicion, and the record never convicted them. `v8.writeHeapSnapshot()` is synchronous
   * and a test timeout cannot interrupt it, so a freeze inside V8 was a fair hypothesis for the file that
   * never reported. But skipping them did NOT end the hang: the next round still printed nothing from this
   * file, and the round after that — with per-test output — showed the stall came before any test here had
   * completed. The `/proc` tests above were the ones holding it, and fixing those is what turned a 3h42m
   * timeout into a run with a summary.
   *
   * Leaving a skip in place for a theory that has been disproved is worse than never having added it: it
   * reads as evidence. A snapshot of a test worker's heap is a fraction of a second, nothing like the 70
   * seconds a 2.7 GB session costs, and the 30-second budget is there for a slow runner.
   */
  it("writes a snapshot and records where it went", async () => {
    const home = await mkdtemp(join(tmpdir(), "hc-heap-"));
    try {
      const sink = new MemorySink();
      const path = await writeHeapSnapshot(home, new Telemetry(sink));
      expect(path).toBeDefined();
      expect(path).toMatch(/\.heapsnapshot$/);
      expect((await readFile(path!, "utf8")).slice(0, 20)).toContain("snapshot"); // V8's own format
      const rec = sink.records.find((r) => r.name === "process.heap_snapshot");
      expect(rec?.attributes["hc.path"]).toBe(path);
    } finally { await rm(home, { recursive: true, force: true }); }
  }, 30_000);

  /** Named by heap size, so a pair says which is which before either is opened. */
  it("puts the heap size in the filename", async () => {
    const home = await mkdtemp(join(tmpdir(), "hc-heap-"));
    try {
      expect(await writeHeapSnapshot(home, new Telemetry(new MemorySink()))).toMatch(/-\d+mb\.heapsnapshot$/);
    } finally { await rm(home, { recursive: true, force: true }); }
  }, 30_000);

  /** A snapshot is a diagnostic; failing to take one must never disturb the run it is diagnosing. */
  it("returns nothing rather than throwing when it cannot write", async () => {
    await expect(writeHeapSnapshot(await blockedPath(), new Telemetry(new MemorySink())))
      .resolves.toBeUndefined();
  });
});

/**
 * A heap cannot be walked while it changes, so a snapshot stops the world for as long as the walk takes.
 *
 * Measured on a live session with a 2.7 GB heap: 70 seconds frozen and a 2.1 GB file. The first version of
 * this called it "a moment", the user's terminal locked up, and they had no way to tell a long pause from a
 * hang. A number that undersells the pause is worse than no number.
 */
describe("estimateFreezeSeconds", () => {
  const GB = 1_073_741_824;

  it("matches what was measured: about 70s for 2.7 GB", () => {
    const s = estimateFreezeSeconds(2.7 * GB);
    expect(s).toBeGreaterThanOrEqual(65);
    expect(s).toBeLessThanOrEqual(80);
  });

  it("scales with the heap it has to walk", () => {
    expect(estimateFreezeSeconds(4 * GB)).toBeGreaterThan(estimateFreezeSeconds(1 * GB));
  });

  /** Never zero: "it will freeze for 0s" reads as "it will not freeze". */
  it("never claims less than a second", () => {
    expect(estimateFreezeSeconds(1024)).toBe(1);
    expect(estimateFreezeSeconds(0)).toBe(1);
  });

  /** Rounded UP, because a pause that outlasts its estimate is what makes someone kill a healthy session. */
  it("rounds up rather than down", () => {
    expect(estimateFreezeSeconds(1.01 * GB)).toBeGreaterThanOrEqual(27);
  });
});

/**
 * React's development build calls `performance.measure()` on every render — `Components ⚛`, `Changed Props`,
 * `+ children` — and Node keeps every entry forever.
 *
 * A heap snapshot of a live session named the leak outright: 1,381,896 `PerformanceMeasure` objects, with
 * those labels among the largest classes on a 2.7 GB heap. Ink re-renders several times a second, so an
 * hours-long run accumulates millions of records nothing will ever read — the ~700 MB/hour the floor climbed.
 */
describe("clearPerfMarks", () => {
  it("empties the user-timing buffer", async () => {
    performance.mark("hc-test-a");
    performance.measure("hc-test-m", "hc-test-a");
    expect(performance.getEntriesByType("measure").length).toBeGreaterThan(0);
    const stop = clearPerfMarks(10);
    try {
      await new Promise((r) => setTimeout(r, 40));
      expect(performance.getEntriesByType("measure")).toHaveLength(0);
      expect(performance.getEntriesByType("mark")).toHaveLength(0);
    } finally { stop(); }
  });

  it("keeps clearing, not just once", async () => {
    const stop = clearPerfMarks(10);
    try {
      await new Promise((r) => setTimeout(r, 25));
      performance.mark("hc-test-b");
      await new Promise((r) => setTimeout(r, 40));
      expect(performance.getEntriesByType("mark")).toHaveLength(0);
    } finally { stop(); }
  });

  it("stops when told to", async () => {
    clearPerfMarks(10)();
    performance.mark("hc-test-c");
    await new Promise((r) => setTimeout(r, 40));
    expect(performance.getEntriesByType("mark").length).toBeGreaterThan(0);
    performance.clearMarks();
  });
});
