/**
 * Where a run's time actually went.
 *
 * Every "why is this slow" answer in this project so far has been inferred from FAILURE COUNTS on the board —
 * how many attempts died, how many reviews rejected — because nothing recorded seconds. That reasoning
 * repeatedly pointed at the right area and could never rank two candidates against each other: a stage that
 * fails often and a stage that is simply slow look identical in a counter.
 *
 * Sums are SLOT time, not wall-clock: several tasks run at once, so the total legitimately exceeds how long
 * the run took. That is the useful measure — it says which stage is consuming the parallel capacity.
 */
export interface StageTotal {
  stage: string;
  ms: number;
  n: number;
}

export class Timings {
  private readonly totals = new Map<string, { ms: number; n: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  record(stage: string, ms: number): void {
    const t = this.totals.get(stage) ?? { ms: 0, n: 0 };
    t.ms += Math.max(0, ms);
    t.n += 1;
    this.totals.set(stage, t);
  }

  /** Times `fn`, recording it whether it succeeds or throws — a stage that fails still consumed the time. */
  async time<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    const started = this.now();
    try {
      return await fn();
    } finally {
      this.record(stage, this.now() - started);
    }
  }

  /** Every stage, heaviest first. */
  summary(): StageTotal[] {
    return [...this.totals.entries()]
      .map(([stage, t]) => ({ stage, ms: t.ms, n: t.n }))
      .sort((a, b) => b.ms - a.ms);
  }

  get empty(): boolean {
    return this.totals.size === 0;
  }
}

const minutes = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);

/**
 * One line naming where the time went, with each stage's share.
 *
 * Shares are of the measured total, not of wall-clock: the point is which stage to attack, and a percentage
 * of something unmeasured would be a guess dressed up as a number.
 */
export function describeTimings(t: Timings): string {
  const rows = t.summary();
  if (!rows.length) return "";
  const total = rows.reduce((n, r) => n + r.ms, 0);
  if (total <= 0) return "";
  const parts = rows
    .filter((r) => r.ms / total >= 0.01) // a stage under one percent is noise in a report about where time goes
    .map((r) => `${r.stage} ${minutes(r.ms)} (${Math.round((r.ms / total) * 100)}% · ${r.n}×)`);
  return `⏱️ Slot time — ${parts.join(" · ")}`;
}
