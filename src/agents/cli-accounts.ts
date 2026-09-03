/**
 * More than one logged-in Claude Code profile, and which one a call should run under.
 *
 * A profile is a DIRECTORY that has been logged into once, by hand: `CLAUDE_CONFIG_DIR` chooses which one the
 * CLI reads its session from. Verified — pointed at an empty directory the CLI answers "Not logged in ·
 * Please run /login" and builds its own tree there. So a second subscription is a second directory, logged in
 * by its own holder through the official flow. No credential is stored here, passed here, or read here; this
 * file only ever names a path.
 *
 * The rule is SPILLOVER, not rotation. The first profile serves until its own limit is nearly spent, and only
 * then does the next one take over. That distinction is the whole design: a run stays on one subscription and
 * reaches for another when the first is genuinely out, rather than alternating to make two limits behave like
 * one bigger limit.
 *
 * With no profiles configured — the ordinary case — nothing changes: `pick` returns undefined and the CLI
 * runs under whatever the person is already logged into.
 */

/** One logged-in profile: a name for the board, a directory for the CLI. */
export interface CliAccount {
  /** How it shows up in telemetry and on a row. A label, not an identity. */
  name: string;
  /** The `CLAUDE_CONFIG_DIR` to run under — already logged in, by hand, once. */
  configDir: string;
}

/**
 * How spent a window has to be before the next profile takes over.
 *
 * Readings arrive one per call, so between two of them utilization can only move by a single call's worth;
 * five points is room enough for that unless one call is enormous. Set lower and a subscription is abandoned
 * with usable quota left; set higher and the spill happens after the limit has already been hit.
 */
export const SPENT = 0.95;

/**
 * The profiles in the order they should be used, with what each was last known to have spent.
 *
 * "Last known" is the honest word. A reading is from that profile's most recent call and says nothing about
 * what has happened since — but it is the only measurement there is, and it comes free with every call.
 */
export class AccountPool {
  private readonly accounts: readonly CliAccount[];
  /** Highest utilization across that profile's windows, from its last call. Absent = never called yet. */
  private readonly spent = new Map<string, number>();

  constructor(accounts: readonly CliAccount[] = []) {
    this.accounts = accounts;
  }

  /**
   * The profile this call should run under, or undefined to run under the ambient login.
   *
   * The first one not yet spent wins, which is what makes this spillover: a profile keeps its place in line
   * for as long as it can still serve. When every profile is spent the last one is returned anyway — there is
   * nothing better to do with the call, and the limit will say so far more precisely than this guess can.
   */
  pick(): CliAccount | undefined {
    if (!this.accounts.length) return undefined;
    return this.accounts.find((a) => (this.spent.get(a.name) ?? 0) < SPENT) ?? this.accounts.at(-1);
  }

  /**
   * File a quota reading against a profile.
   *
   * The windows are taken at their worst: a seven-day limit that is nearly gone stops the profile just as
   * surely as a five-hour one, and reading only the shorter window would keep sending calls to a
   * subscription whose longer window ran out days ago.
   */
  record(name: string, windows: Record<string, number>): void {
    const worst = Math.max(0, ...Object.values(windows));
    this.spent.set(name, worst);
  }

  /** What each profile last reported, for a status line or a report. */
  usage(): { name: string; spent: number | undefined }[] {
    return this.accounts.map((a) => ({ name: a.name, spent: this.spent.get(a.name) }));
  }
}
