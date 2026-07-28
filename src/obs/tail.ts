import { openSync, readSync, closeSync, statSync } from "node:fs";
import { ReportAccumulator, type RunReport } from "./report.js";
import type { Record_ } from "./telemetry.js";

/**
 * Follows a telemetry log, reading only what has been appended since the last look.
 *
 * The panel that shows this redraws every few seconds while the log grows to megabytes. Re-reading and
 * re-parsing the whole file each time would cost more than the work it is watching — the observer would
 * become a load on the thing observed, which is the one thing it must never be.
 *
 * The tail keeps a byte offset and an accumulator, so each poll costs the bytes that actually arrived.
 */
export class TelemetryTail {
  private offset = 0;
  private partial = "";
  private readonly acc = new ReportAccumulator();

  constructor(readonly path: string) {}

  /** Reads whatever is new and returns the report so far. Never throws: a missing log is simply an empty one. */
  read(): RunReport {
    let fd: number | undefined;
    try {
      const size = statSync(this.path).size;
      // A shrunken file is a different run (or a rotation) — start over rather than parse from the middle.
      if (size < this.offset) {
        this.offset = 0;
        this.partial = "";
      }
      if (size > this.offset) {
        fd = openSync(this.path, "r");
        const buf = Buffer.allocUnsafe(size - this.offset);
        const read = readSync(fd, buf, 0, buf.length, this.offset);
        this.offset += read;
        this.consume(this.partial + buf.subarray(0, read).toString("utf8"));
      }
    } catch {
      // no log yet, or it vanished — the report simply stays where it was
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
    }
    return this.acc.report();
  }

  /**
   * Feeds whole lines to the accumulator and holds back the last partial one.
   *
   * The writer appends as it goes, so a read almost always lands mid-line. Parsing that fragment would drop
   * the record; keeping it until its newline arrives loses nothing.
   */
  private consume(text: string): void {
    const lines = text.split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.acc.add(JSON.parse(line) as Record_);
      } catch {
        // a malformed line is skipped rather than allowed to end the watch
      }
    }
  }
}
