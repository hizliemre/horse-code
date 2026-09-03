import { join } from "node:path";
import type { CliKind } from "./cli-agent.js";
import type { AuthStatus } from "./cli-auth.js";

/**
 * `hcode add-provider claude|codex` — connecting one more subscription.
 *
 * horse-code does not authenticate anything and never sees a credential. It picks a directory the CLI has
 * not been pointed at before, hands the terminal to that CLI's own sign-in, and afterwards asks the CLI
 * whether it worked. What it contributes is the bookkeeping around that: a directory that will not collide,
 * the ambient login not being lost, a refusal to file the same account twice, and a config write that leaves
 * everything else alone.
 */

/** One profile as the config records it. Identity is stored; quota is not — that is measured, not declared. */
export interface AccountEntry {
  kind: CliKind;
  name: string;
  /** The profile directory, or absent for the login already in use — see `CliAccount.configDir`. */
  configDir?: string;
  /** Who the CLI said this was, when it was connected. Shown in the startup summary. */
  email?: string;
  /** The subscription as the CLI described it — `max`, `pro`, `ChatGPT`. */
  plan?: string;
}

/** A profile directory no existing account is using. */
export function freshDir(kind: CliKind, home: string, taken: readonly AccountEntry[]): string {
  const used = new Set(taken.map((a) => a.configDir));
  for (let n = 2; ; n++) {
    const dir = join(home, ".horsecode", "profiles", `${kind}-${n}`);
    if (!used.has(dir)) return dir;
  }
}

/** A name for a profile: the account it belongs to when the CLI names one, else the directory it lives in. */
export function nameFor(kind: CliKind, status: AuthStatus, dir: string): string {
  return status.email ?? `${kind}-${dir.split("/").pop() ?? "profile"}`;
}

/**
 * The account list with the ambient login included, if this is the first profile of its kind and that login
 * is real.
 *
 * Without this, connecting a second subscription would SILENTLY RETIRE the first: the pool only offers
 * profiles it knows about, so a list holding just the new one sends every call there while the subscription
 * the person has been using all along sits idle. The ambient login goes first because it is the one they
 * were already spending — spillover should start where they are.
 */
export function withAmbient(
  kind: CliKind,
  existing: readonly AccountEntry[],
  ambient: AuthStatus,
): AccountEntry[] {
  if (existing.some((a) => a.kind === kind)) return [...existing];
  if (!ambient.loggedIn) return [...existing];
  return [
    ...existing,
    {
      kind,
      name: ambient.email ?? `${kind}-default`,
      ...(ambient.email ? { email: ambient.email } : {}),
      ...(ambient.plan ? { plan: ambient.plan } : {}),
    },
  ];
}

/** Everything the command needs from the outside world, so the flow itself can be tested without either CLI. */
export interface AddProviderIO {
  home: string;
  /** The global config as it stands. Merged back, never rewritten — `apiKey` and the rest must survive. */
  readConfig: () => Record<string, unknown>;
  writeConfig: (config: Record<string, unknown>) => void;
  /** Hands the terminal to the CLI's own login, pointed at one profile. */
  login: (kind: CliKind, configDir?: string) => { ok: boolean; error?: string };
  /** Asks a CLI who it is logged in as — under one profile, or under the ambient login when none is given. */
  check: (kind: CliKind, configDir?: string) => AuthStatus;
  log: (line: string) => void;
}

/** Reads the account list out of a config object, ignoring anything malformed. */
export function accountsIn(config: Record<string, unknown>): AccountEntry[] {
  const raw = config.accounts;
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is AccountEntry => {
    const e = a as AccountEntry;
    if (typeof a !== "object" || a === null) return false;
    if (e.kind !== "claude" && e.kind !== "codex") return false;
    // A missing directory is meaningful (the ambient login); a non-string one is malformed.
    return e.configDir === undefined || typeof e.configDir === "string";
  });
}

/**
 * Connect one more subscription. Returns the process exit code.
 *
 * The config is only written after the CLI confirms a real session. A failed or abandoned login leaves
 * nothing behind — a profile recorded on optimism would be picked for real work and fail every call.
 */
export function addProvider(kind: CliKind, io: AddProviderIO): number {
  const config = io.readConfig();
  const existing = accountsIn(config);

  /**
   * The ambient login is checked BEFORE the new one is created, because afterwards it is ambiguous: the
   * environment this process passes down is the one it inherited, and it is the answer to "what would a call
   * with no profile do".
   */
  const accounts = withAmbient(kind, existing, io.check(kind));
  if (accounts.length > existing.length) {
    const a = accounts.at(-1)!;
    io.log(`Recorded the ${kind} account you are already signed in as: ${a.email ?? a.name}${a.plan ? ` (${a.plan})` : ""}`);
    io.log(`It stays first in line, so runs keep spending it before anything added now.`);
  }

  const dir = freshDir(kind, io.home, accounts);
  io.log(`\nOpening ${kind}'s own sign-in, for a NEW profile at ${dir}.`);
  io.log(`Sign in with the account you want to add — not the one already connected.\n`);

  const r = io.login(kind, dir);
  if (!r.ok) {
    io.log(`\n${kind} sign-in did not complete${r.error ? `: ${r.error}` : ""}. Nothing was changed.`);
    /**
     * The reason is in the BROWSER, not here, and saying so is the difference between a useful failure and a
     * dead end. The sign-in refusal comes back on the OAuth callback — a real one read
     * `error=access_denied&error_description=account_on_hold` — while the CLI reports only that no code
     * arrived, and horse-code, which never sees that exchange, can say even less. Someone told "did not
     * complete" starts debugging this command; the answer was in the address bar the whole time.
     */
    io.log(`If a browser page opened, its address holds the reason — an \`error=\` there is the account being refused, not this command failing.`);
    io.log(`Nothing needs cleaning up: ${dir} holds no session, and running this again reuses it.`);
    return 1;
  }

  const status = io.check(kind, dir);
  if (!status.loggedIn) {
    io.log(`\n${kind} still reports no session in ${dir}. Nothing was changed — run this again to retry.`);
    return 1;
  }

  /**
   * The same account twice is worse than useless: it would look like added capacity while both entries draw
   * down one limit, so a run would believe it had somewhere to spill to and find the same exhausted
   * subscription waiting.
   */
  const already = status.email ? accounts.find((a) => a.kind === kind && a.email === status.email) : undefined;
  if (already) {
    io.log(`\nThat is the account already connected as "${already.name}". Nothing was changed.`);
    return 1;
  }

  const entry: AccountEntry = {
    kind,
    name: nameFor(kind, status, dir),
    configDir: dir,
    ...(status.email ? { email: status.email } : {}),
    ...(status.plan ? { plan: status.plan } : {}),
  };
  // Spread first so every other setting — `apiKey` above all — is carried through untouched.
  io.writeConfig({ ...config, accounts: [...accounts, entry] });

  const mine = [...accounts, entry].filter((a) => a.kind === kind);
  io.log(`\nConnected ${entry.email ?? entry.name}${entry.plan ? ` (${entry.plan})` : ""}.`);
  io.log(`${mine.length} ${kind} account${mine.length === 1 ? "" : "s"} now connected. Runs use them in order, spilling to the next when one is nearly out.`);
  return 0;
}
