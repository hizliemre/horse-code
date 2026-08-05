import { redactRecord } from "./redact.js";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { Record_, TelemetrySink } from "./telemetry.js";

/** Where a run's telemetry lands, under the user's home. One file per run. */
export function telemetryDir(home: string): string {
  return join(home, ".horsecode", "telemetry");
}

/**
 * How many records may queue before writes are dropped rather than allowed to grow without bound.
 *
 * Telemetry is an observer. A slow disk must cost the record, never the run — and an unbounded queue in a
 * process that already died twice on the heap ceiling is not a trade worth making.
 */
export const MAX_QUEUE = 10_000;

/**
 * Appends records as JSON Lines.
 *
 * One object per line is what Loki's pipeline reads with no configuration, what `jq` reads with no
 * configuration, and what an OTLP exporter can be pointed at later. Writes are fire-and-forget: nothing in
 * the pipeline ever awaits the log, and every failure is swallowed — an observer that can fail the thing it
 * observes is worse than no observer.
 */
export class FileSink implements TelemetrySink {
  private stream: WriteStream | undefined;
  private queued = 0;
  private dropped = 0;
  readonly path: string;

  constructor(home: string, runId: string) {
    this.path = join(telemetryDir(home), `${runId}.jsonl`);
    try {
      mkdirSync(telemetryDir(home), { recursive: true });
      this.stream = createWriteStream(this.path, { flags: "a" });
      this.stream.on("error", () => { this.stream = undefined; }); // a broken log must not raise
    } catch {
      this.stream = undefined;
    }
  }

  /** Redacted here: one sink, and dozens of places that write to it. See src/obs/redact.ts. */
  write(record: Record_): void {
    record = redactRecord(record);
    if (!this.stream) return;
    if (this.queued >= MAX_QUEUE) { this.dropped++; return; }
    this.queued++;
    try {
      this.stream.write(`${JSON.stringify(record)}\n`, () => { this.queued--; });
    } catch {
      this.queued--;
    }
  }

  /** How many records were dropped because the queue was full — reported rather than hidden. */
  get lost(): number {
    return this.dropped;
  }

  async flush(): Promise<void> {
    const s = this.stream;
    if (!s) return;
    this.stream = undefined;
    await new Promise<void>((resolve) => s.end(() => resolve()));
  }
}

/** Collects records in memory. For tests, and for anything that wants to assert on what was recorded. */
export class MemorySink implements TelemetrySink {
  readonly records: Record_[] = [];
  write(record: Record_): void { this.records.push(record); }
  async flush(): Promise<void> { /* nothing to flush */ }
}
