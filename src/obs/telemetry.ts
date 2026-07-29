import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/**
 * Structured, span-based telemetry for everything the system does.
 *
 * Every question asked of this project so far — why is it slow, why did that task fail, which stage burns the
 * budget — was answered by reading a board file and counting outcomes. That works and it is slow, manual, and
 * blind to anything the board does not happen to record: how long one model call took, what a tool returned,
 * which deterministic branch was chosen and why.
 *
 * The shape is OpenTelemetry's, deliberately: `traceId`/`spanId`/`parentSpanId`, a duration, a status, and
 * attributes under the OTel GenAI conventions (`gen_ai.*`). It is written as JSON Lines to a local file, which
 * Loki ingests as-is and Grafana charts without a translation step — and an OTLP exporter can be added behind
 * this same interface later without touching a single call site.
 */

/** One finished span, as written to the log. Field names follow OTel so a collector can read them unchanged. */
export interface SpanRecord {
  ts: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  durationMs: number;
  status: "ok" | "error";
  error?: string;
  attributes: Attributes;
}

/** A point in time rather than an interval — a decision taken, a threshold crossed. */
export interface EventRecord {
  ts: string;
  traceId?: string;
  spanId?: string;
  name: string;
  kind: "event";
  attributes: Attributes;
}

export type Attributes = Record<string, string | number | boolean | undefined>;
export type SpanKind = "internal" | "client" | "server";
export type Record_ = SpanRecord | EventRecord;

/** Where records go. A file in production; an array in tests. */
export interface TelemetrySink {
  write(record: Record_): void;
  flush(): Promise<void>;
}

interface Ctx {
  traceId: string;
  spanId: string;
  /** Attributes every span beneath this one inherits — the role, the task, the phase. */
  baggage: Attributes;
}

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

/**
 * A span's parent is found through async context, not through an argument.
 *
 * Threading a span handle through `runRoleAgent` → `executeToolCalls` → a tool would have touched every
 * signature in the codebase and been forgotten at the first new call site. `AsyncLocalStorage` follows the
 * await chain on its own, so instrumenting four chokepoints yields a complete tree.
 */
const store = new AsyncLocalStorage<Ctx>();

export class Telemetry {
  constructor(
    private readonly sink: TelemetrySink,
    private readonly now: () => number = () => Date.now(),
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  /** The trace/span this code is running inside, when there is one. */
  current(): { traceId: string; spanId: string } | undefined {
    const c = store.getStore();
    return c ? { traceId: c.traceId, spanId: c.spanId } : undefined;
  }

  /**
   * Runs `fn` inside a new span, recording how long it took and whether it threw.
   *
   * A failing span is recorded exactly like a passing one: a stage that dies after twenty minutes is the most
   * interesting row in the log, and swallowing it would hide the very thing the log exists to show.
   */
  async span<T>(name: string, attributes: Attributes, fn: () => Promise<T>, kind: SpanKind = "internal"): Promise<T> {
    const parent = store.getStore();
    const ctx: Ctx = {
      traceId: parent?.traceId ?? hex(16),
      spanId: hex(8),
      baggage: { ...parent?.baggage, ...pickBaggage(attributes) },
    };
    const started = this.now();
    const finish = (status: "ok" | "error", error?: string): void => {
      this.sink.write({
        ts: this.clock(),
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        ...(parent ? { parentSpanId: parent.spanId } : {}),
        name,
        kind,
        durationMs: this.now() - started,
        status,
        ...(error ? { error: error.slice(0, 500) } : {}),
        attributes: clean({ ...parent?.baggage, ...attributes }),
      });
    };
    return store.run(ctx, async () => {
      try {
        const out = await fn();
        finish("ok");
        return out;
      } catch (e) {
        finish("error", e instanceof Error ? e.message : String(e));
        throw e;
      }
    });
  }

  /** Records something that happened, with no duration — a decision, a threshold, a fallback. */
  event(name: string, attributes: Attributes = {}): void {
    const c = store.getStore();
    this.sink.write({
      ts: this.clock(),
      ...(c ? { traceId: c.traceId, spanId: c.spanId } : {}),
      name,
      kind: "event",
      attributes: clean({ ...c?.baggage, ...attributes }),
    });
  }

  /** Adds attributes that every span beneath this point inherits (the role, the task, the phase). */
  async withBaggage<T>(baggage: Attributes, fn: () => Promise<T>): Promise<T> {
    const parent = store.getStore();
    if (!parent) return fn();
    return store.run({ ...parent, baggage: { ...parent.baggage, ...pickBaggage(baggage) } }, fn);
  }

  flush(): Promise<void> {
    return this.sink.flush();
  }
}

/**
 * Which attributes descend to child spans.
 *
 * Only `hc.*` — the ones that say WHOSE work this is: the run, the task, the role, the phase. A model name or
 * a token count belongs to the span that measured it and would be a lie one level down.
 */
function pickBaggage(a: Attributes): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(a)) if (k.startsWith("hc.") && v !== undefined) out[k] = v;
  return out;
}

function clean(a: Attributes): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(a)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * How often the process's own memory is recorded.
 *
 * This project has now died to the V8 heap limit three times, and each post-mortem started from a stack
 * trace and a guess — the crash names whichever allocation happened to be last, not whatever grew. A
 * sample every half minute costs one number and turns the next one into a curve.
 */
export const HEAP_SAMPLE_MS = 30_000;

/**
 * Starts sampling heap usage into the log. Returns a stop function.
 *
 * `heapUsed` is what the limit is measured against; `rss` says whether the growth is JS objects or something
 * outside the heap (buffers, native memory), which are different problems with different fixes.
 */
export function sampleMemory(t: Telemetry, everyMs = HEAP_SAMPLE_MS): () => void {
  const tick = (): void => {
    const m = process.memoryUsage();
    t.event("process.memory", {
      "hc.heap_used_mb": Math.round(m.heapUsed / 1048576),
      "hc.heap_total_mb": Math.round(m.heapTotal / 1048576),
      "hc.rss_mb": Math.round(m.rss / 1048576),
      "hc.external_mb": Math.round(m.external / 1048576),
    });
  };
  tick();
  const timer = setInterval(tick, everyMs);
  timer.unref?.(); // a sampler must never be the reason the process stays alive
  return () => clearInterval(timer);
}

/**
 * Writes a V8 heap snapshot next to the run's telemetry, and records where it went.
 *
 * Three heap deaths were each diagnosed from a stack trace and a guess, and the sampling added afterwards
 * proved a real rise — the post-GC floor climbing from 11 MB to over 1.5 GB in a working run — without
 * saying WHAT was being retained. A stack trace names the last allocation; a curve names the shape; only a
 * snapshot names the objects.
 *
 * Two snapshots taken an hour apart, compared in Chrome DevTools (Load profile → Comparison view), turn
 * "something is growing" into a class name and a retainer path.
 *
 * It STOPS THE WORLD, and there is no way around that: a heap cannot be walked while it changes. Measured on
 * a live session with a 2.7 GB heap — 70 seconds frozen and a 2.1 GB file. The first version of this called it
 * "a moment", the user's terminal locked up, and they had no way to tell a long pause from a hang. Callers
 * must say what it will cost BEFORE they call, which is what `estimateFreezeSeconds` is for.
 */
/**
 * Roughly how long the freeze will last, from the heap it has to walk.
 *
 * Measured: 2.7 GB took about 70 seconds, so ~26 seconds per gigabyte. Deliberately rounded up and never
 * below one second — a number that undersells the pause is worse than no number, because the user is left
 * deciding whether to kill a session that is merely working.
 */
export function estimateFreezeSeconds(heapUsedBytes = process.memoryUsage().heapUsed): number {
  return Math.max(1, Math.ceil((heapUsedBytes / 1_073_741_824) * 26));
}

export async function writeHeapSnapshot(dir: string, tel: Telemetry = active): Promise<string | undefined> {
  try {
    const v8 = await import("node:v8");
    const { mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(dir, { recursive: true });
    const used = Math.round(process.memoryUsage().heapUsed / 1048576);
    // Named by heap size, so a pair of snapshots says which is which before either is opened.
    const path = join(dir, `heap-${new Date().toISOString().replace(/[:.]/g, "-")}-${used}mb.heapsnapshot`);
    v8.writeHeapSnapshot(path);
    tel.event("process.heap_snapshot", { "hc.path": path, "hc.heap_used_mb": used });
    return path;
  } catch {
    // A snapshot is a diagnostic; failing to take one must never disturb the run it is diagnosing.
    return undefined;
  }
}

/** Telemetry that records nothing, for code paths (and tests) that have no sink. */
export const NO_TELEMETRY = new Telemetry({ write: () => undefined, flush: async () => undefined });

/**
 * The process's telemetry, reached directly rather than passed down.
 *
 * The same argument that put span context in `AsyncLocalStorage`: there is exactly ONE of these per process,
 * and threading it would have added a parameter to every options object in the codebase — where the next new
 * call site would forget it and lose its subtree. Off by default, so a test or a library consumer records
 * nothing until something deliberately turns it on.
 */
let active: Telemetry = NO_TELEMETRY;

export function setTelemetry(t: Telemetry): void {
  active = t;
}

export function telemetry(): Telemetry {
  return active;
}
