import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CliKind } from "./cli-agent.js";

/**
 * More than one logged-in profile per CLI, and which one a call should run under.
 *
 * A profile is a DIRECTORY that has been logged into once, by hand, through the CLI's own sign-in:
 * `CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for Codex. Verified against both — pointed at an empty
 * directory each reports itself logged out and builds its own tree there. So a second subscription is a
 * second directory, and no credential is stored, passed, or read here; this file only ever names a path.
 *
 * The rule is SPILLOVER, not rotation. The first profile of a kind serves until its own limit is nearly
 * spent, and only then does the next take over. That distinction is the whole design: a run stays on one
 * subscription and reaches for another when the first is genuinely out, rather than alternating to make two
 * limits behave like one bigger limit.
 *
 * With no profiles configured — the ordinary case — nothing changes: `pick` returns undefined and each CLI
 * runs under whatever the person is already logged into.
 */

/** One logged-in profile: which CLI it belongs to, a name for the board, a directory for the CLI. */
export interface CliAccount {
  /** Claude profiles and Codex profiles are separate worlds; a call is only ever offered its own kind. */
  kind: CliKind;
  /** How it shows up in a summary and in telemetry. A label, not an identity. */
  name: string;
  /**
   * The profile directory to run under, or ABSENT for the login already in use.
   *
   * Absent is not a missing value, it is the default profile — and it has to be expressed as absence rather
   * than as a path. Measured: Claude Code keeps its ambient session in the macOS Keychain, and setting
   * `CLAUDE_CONFIG_DIR` at all switches it to file credentials inside that directory. So pointing an entry
   * at `~/.claude` — the obvious guess — reports LOGGED OUT even though the person plainly is logged in
   * there, because no `.credentials.json` exists beside it. The only way to name that session is to say
   * nothing and let the CLI find it.
   */
  configDir?: string;
  /** Who the CLI said this was when it was connected. Identity is stable; quota is measured, not declared. */
  email?: string;
  /** The subscription as the CLI described it — `max`, `pro`, `ChatGPT`. */
  plan?: string;
}

/**
 * How spent a window has to be before the next profile of the same kind takes over.
 *
 * Readings arrive one per call, so between two of them utilization can only move by a single call's worth;
 * five points is room enough for that unless one call is enormous. Set lower and a subscription is abandoned
 * with usable quota left; set higher and the spill happens after the limit has already been hit.
 */
export const SPENT = 0.95;

/** A profile's last known utilization, and when it was taken. */
export interface Reading {
  /** Highest utilization across that profile's windows, 0–1. */
  spent: number;
  /** Epoch milliseconds. Kept because a reading's age is most of what it is worth. */
  at: number;
}

/**
 * Where readings survive between sessions.
 *
 * A reading only ever arrives WITH a call, so a fresh process knows nothing about any subscription until it
 * has already spent from one. That is exactly backwards for a summary printed at startup, which is the one
 * moment a person wants to know what is left before committing a run to it.
 */
export interface UsageStore {
  load(): Record<string, Reading>;
  save(readings: Record<string, Reading>): void;
}

/** The key a profile is filed under. Kinds are separate, so the kind is part of the identity. */
export function readingKey(kind: CliKind, name: string): string {
  return `${kind}:${name}`;
}

/** Readings on disk, beside the config they describe. A corrupt or absent file simply means "nothing known". */
export function fileUsageStore(home: string): UsageStore {
  const path = join(home, ".horsecode", "usage.json");
  return {
    load(): Record<string, Reading> {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (typeof parsed !== "object" || parsed === null) return {};
        const out: Record<string, Reading> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          const r = v as { spent?: unknown; at?: unknown };
          if (typeof r?.spent === "number" && typeof r?.at === "number") out[k] = { spent: r.spent, at: r.at };
        }
        return out;
      } catch {
        return {};
      }
    },
    save(readings: Record<string, Reading>): void {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(readings, null, 2) + "\n");
      } catch {
        // Telemetry, not the work. A run that cannot write this file still has every reason to continue.
      }
    },
  };
}

/**
 * The profiles in the order they should be used, with what each was last known to have spent.
 *
 * "Last known" is the honest word. A reading is from that profile's most recent call and says nothing about
 * what has happened since — but it is the only measurement there is, and it comes free with every call.
 */
export class AccountPool {
  private readonly accounts: readonly CliAccount[];
  private readonly store?: UsageStore;
  private readings: Record<string, Reading>;

  constructor(accounts: readonly CliAccount[] = [], store?: UsageStore) {
    this.accounts = accounts;
    this.store = store;
    this.readings = store?.load() ?? {};
  }

  /**
   * The profile a call of this kind should run under, or undefined to run under the ambient login.
   *
   * The first one not yet spent wins, which is what makes this spillover: a profile keeps its place in line
   * for as long as it can still serve. When every profile of a kind is spent the last one is returned anyway
   * — there is nothing better to do with the call, and the limit itself will say so far more precisely than
   * this guess can.
   */
  pick(kind: CliKind): CliAccount | undefined {
    const mine = this.accounts.filter((a) => a.kind === kind);
    if (!mine.length) return undefined;
    return mine.find((a) => (this.readings[readingKey(kind, a.name)]?.spent ?? 0) < SPENT) ?? mine.at(-1);
  }

  /**
   * File a quota reading against a profile.
   *
   * The windows are taken at their worst: a seven-day limit that is nearly gone stops the profile just as
   * surely as a five-hour one, and reading only the shorter window would keep sending calls to a
   * subscription whose longer window ran out days ago.
   */
  record(kind: CliKind, name: string, windows: Record<string, number>, now = Date.now()): void {
    const spent = Math.max(0, ...Object.values(windows));
    this.readings = { ...this.readings, [readingKey(kind, name)]: { spent, at: now } };
    this.store?.save(this.readings);
  }

  /** Every configured profile with its last reading, for a startup summary or a status line. */
  usage(): { account: CliAccount; reading?: Reading }[] {
    return this.accounts.map((a) => {
      const r = this.readings[readingKey(a.kind, a.name)];
      return { account: a, ...(r ? { reading: r } : {}) };
    });
  }

  /** How many profiles are configured, in total or for one CLI. */
  count(kind?: CliKind): number {
    return kind ? this.accounts.filter((a) => a.kind === kind).length : this.accounts.length;
  }
}

/** "12m", "3h", "2d" — a reading's age is most of what it is worth. */
export function ageOf(at: number, now: number): string {
  const mins = Math.max(0, Math.round((now - at) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/**
 * The startup summary: how many subscriptions are connected, who they are, and what each had left.
 *
 * Silent when nothing is configured. That is the ordinary case — the ambient login works and the person
 * never opted into any of this — and a line printed on every single run to say so would be pure noise.
 *
 * Every figure carries its age, because none of them is current: a reading arrives with a call and says
 * nothing about what happened after it. Printed bare, "42%" would read as a fact about now rather than about
 * whenever that profile was last used, which for a second subscription can be days.
 */
export function summarizeAccounts(
  usage: { account: CliAccount; reading?: Reading }[],
  now = Date.now(),
): string[] {
  if (!usage.length) return [];
  const byKind = new Map<CliKind, number>();
  for (const { account } of usage) byKind.set(account.kind, (byKind.get(account.kind) ?? 0) + 1);
  const counts = [...byKind].map(([k, n]) => `${n} ${k}`).join(" · ");

  const rows = usage.map(({ account, reading }) => {
    const who = account.email ?? account.name;
    const plan = account.plan ? ` (${account.plan})` : "";
    const left = reading
      ? `${Math.round(reading.spent * 100)}% used · ${ageOf(reading.at, now)} ago`
      : "not used yet";
    return `   ${account.kind.padEnd(6)} ${`${who}${plan}`.padEnd(34)} ${left}`;
  });
  return [`🔑 ${counts} account${usage.length === 1 ? "" : "s"} connected`, ...rows];
}
