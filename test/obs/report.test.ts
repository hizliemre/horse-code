import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarize, describeReport, readTelemetry } from "../../src/obs/report.js";
import { TelemetryTail } from "../../src/obs/tail.js";
import type { Record_ } from "../../src/obs/telemetry.js";

const stage = (name: string, ms: number, status: "ok" | "error" = "ok"): Record_ => ({
  ts: "2026-07-28T00:00:00.000Z", traceId: "t", spanId: "s", name: `stage.${name}`, kind: "internal",
  durationMs: ms, status, attributes: {},
});
const chat = (over: Record<string, unknown> = {}): Record_ => ({
  ts: "2026-07-28T00:00:00.000Z", name: "gen_ai.chat", kind: "event",
  attributes: {
    "gen_ai.request.model": "cc/opus", "gen_ai.usage.input_tokens": 20_000,
    "hc.duration_ms": 6_000, "hc.tools_requested": 1, "hc.status": "ok", ...over,
  },
});
const read = (task: string, subject: string): Record_ => ({
  ts: "2026-07-28T00:00:00.000Z", name: "tool.result", kind: "event",
  attributes: { "hc.tool": "read_file", "hc.task.id": task, "hc.tool.subject": subject },
});

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-rep-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/**
 * These are the three questions that turned out to matter while watching real runs from the outside with a
 * script: where the slot time goes, whether turns ask for one tool at a time, and whether one agent is
 * reading one file over and over. A tool that cannot answer them about itself makes everyone rediscover
 * them by hand.
 */
describe("summarize", () => {
  it("totals each stage and counts the ones that failed", () => {
    const r = summarize([
      stage("implementation", 600_000), stage("implementation", 600_000, "error"),
      stage("test_suite", 120_000),
    ]);
    expect(r.stages[0]).toEqual({ stage: "implementation", seconds: 1200, runs: 2, failed: 1 });
    expect(r.stages[1].stage).toBe("test suite"); // underscores are for span names, not for people
  });

  it("puts the heaviest stage first — that is the one to attack", () => {
    const r = summarize([stage("git", 1_000), stage("code_review", 90_000), stage("test_suite", 300_000)]);
    expect(r.stages.map((s) => s.stage)).toEqual(["test suite", "code review", "git"]);
  });

  /** 419 of 527 turns asked for exactly one tool, and every turn re-sends the whole conversation. */
  it("counts how many turns asked for a single tool", () => {
    const r = summarize([chat(), chat(), chat({ "hc.tools_requested": 4 })]);
    expect(r.turns).toBe(3);
    expect(r.toolCalls).toBe(6);
    expect(r.singleToolTurns).toBe(2);
  });

  it("adds up what the model cost", () => {
    const r = summarize([chat(), chat()]);
    expect(r.promptTokens).toBe(40_000);
    expect(r.modelSeconds).toBe(12);
  });

  it("names the models whose calls came back as errors", () => {
    const r = summarize([chat({ "hc.status": "error" }), chat({ "hc.status": "error" }), chat()]);
    expect(r.errors).toEqual([{ model: "cc/opus", count: 2 }]);
  });

  /** One agent reading one file repeatedly is a loop; two agents reading one file is just two agents. */
  it("reports a file re-read by the SAME task, and ignores one read once by several", () => {
    const r = summarize([
      read("T1", "path:store.ts"), read("T1", "path:store.ts"), read("T1", "path:store.ts"),
      read("T2", "path:other.ts"), read("T3", "path:other.ts"),
    ]);
    expect(r.reReads).toEqual([{ task: "T1", subject: "path:store.ts", count: 3 }]);
  });

  it("is empty for an empty log", () => {
    const r = summarize([]);
    expect(r.records).toBe(0);
    expect(r.stages).toEqual([]);
  });
});

describe("describeReport", () => {
  it("leads with where the slot time went", () => {
    const line = describeReport(summarize([stage("implementation", 600_000), stage("test_suite", 200_000)]));
    expect(line).toContain("Slot time");
    expect(line).toMatch(/implementation 10m \(75%/);
  });

  it("says so plainly when nothing has finished yet", () => {
    expect(describeReport(summarize([chat()]))).toContain("no stage has finished yet");
  });

  it("says there is nothing at all rather than printing empty headings", () => {
    expect(describeReport(summarize([]))).toBe("No telemetry yet for this run.");
  });
});

/**
 * The panel redraws every few seconds while the log grows to megabytes. Re-reading all of it each time would
 * make the observer a load on the thing observed.
 */
describe("TelemetryTail", () => {
  const line = (r: Record_): string => `${JSON.stringify(r)}\n`;

  it("reads only what was appended since the last look", async () => {
    const path = join(dir, "run.jsonl");
    await writeFile(path, line(chat()));
    const tail = new TelemetryTail(path);
    expect(tail.read().turns).toBe(1);
    await appendFile(path, line(chat()) + line(chat()));
    expect(tail.read().turns).toBe(3); // accumulated, not re-counted from scratch
  });

  /** The writer appends as it goes, so a read almost always lands mid-line. */
  it("holds back a half-written line until its newline arrives", async () => {
    const path = join(dir, "run.jsonl");
    const whole = line(chat());
    await writeFile(path, whole + whole.slice(0, 20));
    const tail = new TelemetryTail(path);
    expect(tail.read().turns).toBe(1);
    await appendFile(path, whole.slice(20));
    expect(tail.read().turns).toBe(2);
  });

  it("starts over when the file shrinks, rather than parsing from the middle", async () => {
    const path = join(dir, "run.jsonl");
    await writeFile(path, line(chat()) + line(chat()));
    const tail = new TelemetryTail(path);
    expect(tail.read().turns).toBe(2);
    await writeFile(path, line(chat())); // a new, shorter run in the same place
    expect(tail.read().turns).toBeGreaterThan(0);
  });

  it("treats a missing log as an empty one", () => {
    expect(new TelemetryTail(join(dir, "nope.jsonl")).read().records).toBe(0);
  });

  it("skips a malformed line instead of ending the watch", async () => {
    const path = join(dir, "run.jsonl");
    await writeFile(path, `{not json\n${line(chat())}`);
    expect(new TelemetryTail(path).read().turns).toBe(1);
  });
});

describe("readTelemetry", () => {
  it("parses a whole log, ignoring a truncated tail", async () => {
    const path = join(dir, "run.jsonl");
    await writeFile(path, `${JSON.stringify(chat())}\n${JSON.stringify(chat()).slice(0, 10)}`);
    expect(readTelemetry(path)).toHaveLength(1);
  });

  it("returns nothing for a file that is not there", () => {
    expect(readTelemetry(join(dir, "nope.jsonl"))).toEqual([]);
  });
});

/**
 * Caught live: two implementer attempts ended in three seconds each — one model call, `finish_reason: stop`,
 * no tool calls at all. The model answered in prose and stopped, so the attempt wrote nothing and the ladder
 * rotated to the next model. The waste is bounded; what was missing was any way to see that ONE model
 * accounts for it.
 */
describe("models that write nothing", () => {
  const nothing = (model: string): Record_ => ({
    ts: "2026-07-28T00:00:00.000Z", name: "implementer.no_changes", kind: "event",
    attributes: { "hc.model": model, "hc.task.id": "T1", "hc.role": "coder" },
  });

  it("counts them by model, heaviest first", () => {
    const r = summarize([nothing("a/one"), nothing("b/two"), nothing("a/one")]);
    expect(r.wroteNothing).toEqual([{ model: "a/one", count: 2 }, { model: "b/two", count: 1 }]);
  });

  it("names them in the report", () => {
    expect(describeReport(summarize([nothing("antigravity/claude-sonnet-4-6")])))
      .toMatch(/Wrote nothing.*antigravity\/claude-sonnet-4-6 x1/);
  });

  it("says nothing about it when every attempt wrote something", () => {
    expect(describeReport(summarize([chat()]))).not.toContain("Wrote nothing");
  });
});

/**
 * This project has died to the V8 heap limit three times, and each post-mortem started from a stack trace
 * and a guess — a crash names whichever allocation happened to be last, not whatever grew. A sample every
 * half minute costs one number and turns the next one into a curve.
 */
describe("memory", () => {
  const mem = (usedMb: number): Record_ => ({
    ts: "2026-07-28T00:00:00.000Z", name: "process.memory", kind: "event",
    attributes: { "hc.heap_used_mb": usedMb, "hc.rss_mb": usedMb + 200, "hc.heap_total_mb": usedMb + 50 },
  });

  it("keeps the latest reading and the highest one", () => {
    const r = summarize([mem(400), mem(3900), mem(1200)]);
    expect(r.heap).toEqual({ usedMb: 1200, peakMb: 3900, rssMb: 1400 });
  });

  it("reports both, because a peak that has passed still says what happened", () => {
    expect(describeReport(summarize([mem(3900), mem(1200)])))
      .toMatch(/Memory.*heap 1200MB \(peak 3900MB\)/);
  });

  it("says nothing about memory before the first sample", () => {
    expect(summarize([]).heap).toBeUndefined();
    expect(describeReport(summarize([chat()]))).not.toContain("Memory");
  });
});

/**
 * A pipeline went completely quiet for eight minutes: live process, full heap, no turns, no tools, nothing.
 *
 * It was waiting on ONE request that had been in flight the whole time — and the log could not say so,
 * because a call is only recorded when its stream closes. The case worth seeing was the one case invisible.
 */
describe("calls that are still in flight", () => {
  const start = (id: string, model = "cc/opus", ts = "2026-07-28T00:00:00.000Z"): Record_ => ({
    ts, name: "gen_ai.chat.start", kind: "event",
    attributes: { "hc.call_id": id, "gen_ai.request.model": model, "hc.messages": 12 },
  });
  const finish = (id: string, ts = "2026-07-28T00:00:10.000Z"): Record_ => ({
    ts, name: "gen_ai.chat", kind: "event",
    attributes: { "hc.call_id": id, "gen_ai.request.model": "cc/opus", "hc.duration_ms": 10_000, "hc.status": "ok" },
  });

  it("counts what started and never finished", () => {
    const r = summarize([start("a"), finish("a"), start("b"), start("c")]);
    expect(r.inFlight.count).toBe(2);
    expect(r.turns).toBe(1); // only the finished one is a turn
  });

  it("says how long the oldest has been out", () => {
    const r = summarize([
      start("a", "cc/opus", "2026-07-28T00:00:00.000Z"),
      { ...finish("z", "2026-07-28T00:08:00.000Z"), attributes: { "hc.call_id": "z" } } as Record_,
    ]);
    expect(r.inFlight.oldestMs).toBe(8 * 60 * 1000);
  });

  /** Read after the fact, a finished log must not claim a call has been hanging for three hours. */
  it("measures against the log's own last record, not the wall clock", () => {
    const r = summarize([start("a", "cc/opus", "2020-01-01T00:00:00.000Z"), start("b", "cc/opus", "2020-01-01T00:01:00.000Z")]);
    expect(r.inFlight.oldestMs).toBe(60_000);
  });

  it("names the models still waiting", () => {
    expect(summarize([start("a", "cx/gpt"), start("b", "cx/gpt")]).inFlight.models).toEqual(["cx/gpt"]);
  });

  it("reports nothing when every call came back", () => {
    const r = summarize([start("a"), finish("a")]);
    expect(r.inFlight.count).toBe(0);
    expect(describeReport(r)).not.toContain("In flight");
  });

  it("puts it in the report when something is stuck", () => {
    expect(describeReport(summarize([start("a"), start("b")]))).toMatch(/In flight.*2 call\(s\)/);
  });
});
