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
