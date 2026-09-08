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
 * Accounts of one kind take TURNS, and a spent one steps out of the rotation.
 *
 * The first design here was spillover — drain one subscription, then start the next — and turns are better
 * for the reason that matters over a long run: two accounts used alternately drain their windows at the same
 * rate, so both refill in parallel and neither is the one thing standing between a board and a stall.
 * Spillover empties one window completely while the other sits full, which is the same total capacity
 * arranged so that it runs out sooner.
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
 * How spent a window has to be before a profile steps out of its kind's rotation.
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
   * Round-robin over the accounts that still have room, so two subscriptions drain together rather than one
   * after the other. A spent one drops out of the rotation and rejoins the moment a reading says it can
   * serve again.
   */
  pick(kind: CliKind): CliAccount | undefined {
    const mine = this.accounts.filter((a) => a.kind === kind);
    if (!mine.length) return undefined;
    const live = mine.filter((a) => (this.readings[readingKey(kind, a.name)]?.spent ?? 0) < SPENT);
    /**
     * Everything spent still names one. There is nothing better to do with the call, and the reading this
     * would refuse on is only ever "as of that profile's last call" — the limit itself answers far more
     * precisely, so this guess must not pre-empt it.
     */
    const pool = live.length ? live : mine;
    const n = this.turn.get(kind) ?? 0;
    this.turn.set(kind, n + 1);
    return pool[n % pool.length];
  }

  /** Whose turn it is, per kind. Turns are per SOURCE: Claude's rotation says nothing about Codex's. */
  private readonly turn = new Map<CliKind, number>();

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

/**
 * `/models` — which models each connected subscription serves, and which of them any role is actually using.
 *
 * The "actually using" column is the point, and it comes from a real failure. Two subscriptions were
 * connected, `/roles adjust` was run, and every one of 192 chain links still named the older two — because
 * the pool handed the tuner only models already in a chain, which no new subscription's are. Nothing in the
 * interface could show that: the start-up line proved the accounts were connected, and the roles table
 * proved the chains were full, and neither answered "is the thing I just paid for doing any work".
 *
 * A subscription with nothing connected is listed too, as an absence rather than an omission — its models
 * are real names that will simply fail, and knowing that before a run beats discovering it during one.
 */
export function modelsPanel(
  usage: { account: CliAccount; reading?: Reading }[],
  models: (kind: CliKind) => readonly string[],
  kinds: readonly CliKind[],
  inUse: readonly string[] = [],
  now = Date.now(),
): string {
  const used = new Set(inUse);
  const rows: string[] = [];
  for (const kind of kinds) {
    const mine = usage.filter((u) => u.account.kind === kind);
    const who = mine.length
      ? mine.map(({ account, reading }) => {
        const name = account.email ?? account.plan ?? account.name;
        return `${name}${reading ? ` · ${Math.round(reading.spent * 100)}% used ${ageOf(reading.at, now)} ago` : ""}`;
      }).join(" · ")
      : "_not connected — these will fail every call_";
    rows.push(`**${kind}** — ${who}`);
    // `●` for a model some role is running, `·` for one that is available and idle.
    rows.push(`  ${models(kind).map((m) => `${used.has(m) ? "●" : "·"} ${m}`).join("   ")}`);
  }
  const idle = kinds.filter((k) => usage.some((u) => u.account.kind === k))
    .filter((k) => !models(k).some((m) => used.has(m)));
  const note = idle.length
    ? `\n\n_● = a role is running it. ${idle.join(" and ")} ${idle.length > 1 ? "are" : "is"} connected but in no chain — \`/roles adjust\` assigns them._`
    : "\n\n_● = a role is running it._";
  return `**Models** — what your connected subscriptions serve\n\n${rows.join("\n")}${note}`;
}

/** "12m", "3h", "2d" — a reading's age is most of what it is worth. */
export function ageOf(at: number, now: number): string {
  const mins = Math.max(0, Math.round((now - at) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/**
 * The start-up account line: what a run will use, whose it is, and what each had left.
 *
 * "Will use" rather than "is configured" is the correction that matters. A first version listed only POOLED
 * profiles, so someone signed into both CLIs and perfectly able to run saw nothing and reasonably concluded
 * no account was connected — the signed-in default each CLI actually uses appeared nowhere, and it is
 * precisely the account every call was about to go to.
 *
 * A CLI nobody is signed into is the most useful entry here: every call routed there will fail, and that is
 * far better learned before a run than during one. Absences are stated rather than omitted, which is the
 * rule the rest of this panel already follows.
 *
 * A figure carries its age, because none of them is current: a reading arrives with a call and says nothing
 * about what happened after. Printed bare, "42%" would read as a fact about now rather than about whenever
 * that profile was last used — which for a spare subscription can be days.
 *
 * One renderer, for the panel and for the plain-output path both. Undefined when there is nothing to say.
 */
export function accountsLine(
  usage: { account: CliAccount; reading?: Reading }[],
  notSignedIn: readonly CliKind[] = [],
  now = Date.now(),
): string | undefined {
  const parts = usage.map(({ account, reading }) => {
    /**
     * Codex names the method it signed in with and no address, so there the plan IS the identity. The `name`
     * behind it is the fallback for a profile that answered with neither.
     */
    const who = `${account.email ?? account.plan ?? account.name}${account.email && account.plan ? ` (${account.plan})` : ""}`;
    const left = reading ? ` ${Math.round(reading.spent * 100)}% used ${ageOf(reading.at, now)} ago` : "";
    return `${account.kind} ${who}${left}`;
  });
  // Stated, not omitted: every call routed to a CLI nobody is signed into will fail, and that is far better
  // learned before a run than during one.
  for (const kind of notSignedIn) parts.push(`${kind} NOT signed in — every ${kind} call will fail`);
  return parts.length ? parts.join(" · ") : undefined;
}
