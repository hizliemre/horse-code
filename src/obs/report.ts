import { readFileSync } from "node:fs";
import type { Record_, SpanRecord, EventRecord } from "./telemetry.js";

/**
 * Reads a run's telemetry back and says what is happening.
 *
 * The log answers "what is going on" only if something asks it the right questions. These are the ones that
 * turned out to matter while watching real runs: where the slot time goes, how many tool calls a turn asks
 * for (419 of 527 turns asked for exactly one, and each turn re-sends the whole conversation), and whether
 * any single agent is reading the same file over and over — the signature of a context-elision loop.
 */

export interface StageTotal { stage: string; seconds: number; runs: number; failed: number }
export interface ReReadTotal { task: string; subject: string; count: number }

export interface RunReport {
  stages: StageTotal[];
  turns: number;
  toolCalls: number;
  /** Turns that asked for exactly one tool — each is a full round-trip for a single lookup. */
  singleToolTurns: number;
  promptTokens: number;
  modelSeconds: number;
  reReads: ReReadTotal[];
  /** Model calls that came back as an error, by model. */
  errors: { model: string; count: number }[];
  /** Models whose implementer attempt wrote no file at all, by model — a whole attempt for nothing. */
  wroteNothing: { model: string; count: number }[];
  records: number;
}

const isEvent = (r: Record_): r is EventRecord => r.kind === "event";
const isSpan = (r: Record_): r is SpanRecord => r.kind !== "event";

/** Parses a JSONL telemetry log. A truncated final line is expected — the run is still writing to it. */
export function readTelemetry(path: string): Record_[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: Record_[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record_);
    } catch {
      // a half-written last line — the writer is still going
    }
  }
  return out;
}

/**
 * Accumulates the report record by record.
 *
 * A class rather than a fold over an array because the log is READ INCREMENTALLY: a run writes megabytes,
 * and re-parsing all of it every few seconds to redraw a panel would cost more than the work it is watching.
 */
export class ReportAccumulator {
  private stages = new Map<string, StageTotal>();
  private reads = new Map<string, ReReadTotal>();
  private errors = new Map<string, number>();
  private nothing = new Map<string, number>();
  private turns = 0;
  private toolCalls = 0;
  private singleToolTurns = 0;
  private promptTokens = 0;
  private modelSeconds = 0;
  private records = 0;

  add(r: Record_): void {
    this.records += 1;
    if (isSpan(r) && r.name.startsWith("stage.")) {
      const key = r.name.slice("stage.".length).replace(/_/g, " ");
      const s = this.stages.get(key) ?? { stage: key, seconds: 0, runs: 0, failed: 0 };
      s.seconds += r.durationMs / 1000;
      s.runs += 1;
      if (r.status === "error") s.failed += 1;
      this.stages.set(key, s);
      return;
    }
    if (!isEvent(r)) return;
    const a = r.attributes;
    if (r.name === "implementer.no_changes") {
      const m = String(a["hc.model"] ?? "?");
      this.nothing.set(m, (this.nothing.get(m) ?? 0) + 1);
      return;
    }
    if (r.name === "gen_ai.chat") {
      this.turns += 1;
      const asked = Number(a["hc.tools_requested"] ?? 0);
      this.toolCalls += asked;
      if (asked === 1) this.singleToolTurns += 1;
      this.promptTokens += Number(a["gen_ai.usage.input_tokens"] ?? 0);
      this.modelSeconds += Number(a["hc.duration_ms"] ?? 0) / 1000;
      if (a["hc.status"] === "error") {
        const m = String(a["gen_ai.request.model"] ?? "?");
        this.errors.set(m, (this.errors.get(m) ?? 0) + 1);
      }
      return;
    }
    // A read repeated by ONE agent is the interesting case: two agents reading one file is just two agents.
    if (r.name === "tool.result" && a["hc.tool"] === "read_file") {
      const task = String(a["hc.task.id"] ?? "-");
      // The KEY, not the display subject: two pages of one file are two different reads, and counting them
      // as one reports a loop that is not there.
      const subject = String(a["hc.tool.key"] ?? a["hc.tool.subject"] ?? "");
      if (!subject) return;
      const key = `${task} ${subject}`;
      const e = this.reads.get(key) ?? { task, subject, count: 0 };
      e.count += 1;
      this.reads.set(key, e);
    }
  }

  report(): RunReport {
    return {
      stages: [...this.stages.values()].sort((a, b) => b.seconds - a.seconds),
      turns: this.turns,
      toolCalls: this.toolCalls,
      singleToolTurns: this.singleToolTurns,
      promptTokens: this.promptTokens,
      modelSeconds: this.modelSeconds,
      reReads: [...this.reads.values()].filter((r) => r.count > 1).sort((a, b) => b.count - a.count).slice(0, 5),
      errors: [...this.errors.entries()].map(([model, count]) => ({ model, count })).sort((a, b) => b.count - a.count),
      wroteNothing: [...this.nothing.entries()].map(([model, count]) => ({ model, count })).sort((a, b) => b.count - a.count),
      records: this.records,
    };
  }
}

export function summarize(records: Record_[]): RunReport {
  const acc = new ReportAccumulator();
  for (const r of records) acc.add(r);
  return acc.report();
}

const mins = (s: number): string => (s < 90 ? `${Math.round(s)}s` : `${Math.round(s / 60)}m`);
const short = (p: string): string => (p.length <= 44 ? p : `…${p.slice(-43)}`);

/** The report as the chat shows it. An empty log says so in one line rather than printing empty headings. */
export function describeReport(r: RunReport): string {
  if (!r.records) return "No telemetry yet for this run.";
  const lines: string[] = [];

  if (r.stages.length) {
    const total = r.stages.reduce((n, s) => n + s.seconds, 0);
    lines.push(`**Slot time** — ${r.stages.map((s) =>
      `${s.stage} ${mins(s.seconds)} (${Math.round((s.seconds / total) * 100)}% · ${s.runs}×` +
      `${s.failed ? `, ${s.failed} failed` : ""})`).join(" · ")}`);
  } else {
    lines.push("**Slot time** — no stage has finished yet.");
  }

  if (r.turns) {
    const perTurn = (r.toolCalls / r.turns).toFixed(2);
    const single = Math.round((r.singleToolTurns / r.turns) * 100);
    lines.push(
      `**Model** — ${r.turns} turns · ${mins(r.modelSeconds)} · ${(r.promptTokens / 1e6).toFixed(1)}M prompt tokens · ` +
      `${perTurn} tools/turn (${single}% of turns asked for just one)`);
  }

  if (r.errors.length) {
    lines.push(`**Failed calls** — ${r.errors.map((e) => `${e.model} x${e.count}`).join(" · ")}`);
  }

  // A whole attempt spent on a model that answered in prose and called no tool at all.
  if (r.wroteNothing.length) {
    lines.push(`**Wrote nothing** — ${r.wroteNothing.map((e) => `${e.model} x${e.count}`).join(" · ")}`);
  }

  // The signature of an elision loop: one agent, one file, over and over.
  if (r.reReads.length) {
    lines.push(`**Re-read most** — ${r.reReads.map((x) => `${x.task} ${short(x.subject)} x${x.count}`).join(" · ")}`);
  }
  return lines.join("\n");
}
