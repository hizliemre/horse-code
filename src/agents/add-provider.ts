import { join } from "node:path";
import { CLI_KINDS, type CliKind } from "./cli-agent.js";
import type { AuthStatus } from "./cli-auth.js";

/**
 * `hcode add-provider claude|codex|grok` — connecting one more subscription.
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

/**
 * A name for a profile: the account it belongs to when the CLI names one, else the directory it lives in.
 *
 * The directory is already named after its kind — `freshDir` builds `profiles/claude-2` — so prefixing it
 * again produced `claude-claude-2`. Invisible while every CLI reported either an address or a plan, and
 * plainly visible now that z.ai reports neither.
 */
export function nameFor(kind: CliKind, status: AuthStatus, dir: string): string {
  const base = dir.split("/").pop() ?? "profile";
  return status.email ?? (base.startsWith(`${kind}-`) ? base : `${kind}-${base}`);
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
  /**
   * z.ai HAS no ambient login, and asking after one returns somebody else's.
   *
   * A z.ai account is a Claude Code profile directory whose settings point elsewhere, so the question "what
   * would a call with no profile do" is answered by Claude Code's own session — the person's ANTHROPIC
   * account, reported with their real address. Recorded as a z.ai account it would be worse than wrong: the
   * pool would hand z.ai's turn to an Anthropic subscription and file the spend against it.
   */
  if (kind === "zai") return [...existing];
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

/** Whether a profile became real, and what to tell the person when it did not. */
export interface LoginResult { ok: boolean; error?: string }

/** Everything the command needs from the outside world, so the flow itself can be tested without any CLI. */
export interface AddProviderIO {
  home: string;
  /** The global config as it stands. Merged back, never rewritten — `apiKey` and the rest must survive. */
  readConfig: () => Record<string, unknown>;
  writeConfig: (config: Record<string, unknown>) => void;
  /**
   * Makes one profile real, and the two shapes of that are why this may be awaited.
   *
   * For the CLIs with a sign-in it hands over the terminal and returns when they are done — synchronous, and
   * blocking on a person. For z.ai there is no sign-in: it asks for a key and puts one real request to the
   * endpoint, which is a network call and therefore a promise. Callers that supply the synchronous kind are
   * unaffected; awaiting a plain value is a plain value.
   */
  login: (kind: CliKind, configDir?: string) => LoginResult | Promise<LoginResult>;
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
    if (!CLI_KINDS.includes(e.kind)) return false;
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
export async function addProvider(kind: CliKind, io: AddProviderIO): Promise<number> {
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
  if (kind === "zai") {
    /**
     * There is nothing to open. Measured: a z.ai profile is a directory containing one settings file, and a
     * directory containing only that file already produces an authenticated request — no browser, no OAuth.
     * Saying "opening z.ai's own sign-in" would send someone looking for a window that never appears.
     */
    io.log(`\nz.ai has no sign-in — an account is an API key, and the profile at ${dir} will hold it.`);
    io.log(`Take the key from your z.ai dashboard; it is written to that profile alone and nowhere else.\n`);
  } else {
    io.log(`\nOpening ${kind}'s own sign-in, for a NEW profile at ${dir}.`);
    io.log(`Sign in with the account you want to add — not the one already connected.\n`);
  }

  const r = await io.login(kind, dir);
  if (!r.ok) {
    if (kind === "zai") {
      io.log(`\nz.ai did not accept that key${r.error ? `: ${r.error}` : ""}. Nothing was changed.`);
      io.log(`The key is checked by making one real call, because \`claude auth status\` reports any token as connected — valid or not.`);
      io.log(`Nothing needs cleaning up: running this again reuses ${dir}.`);
      return 1;
    }
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
  io.log(`${mine.length} ${kind} account${mine.length === 1 ? "" : "s"} now connected. Runs take turns between them.`);
  /**
   * Spillover is claimed only where it can actually happen.
   *
   * Stepping off a nearly-spent subscription needs a quota READING, and a reading only arrives if the CLI
   * reports one. Claude Code sends `rate_limit_event` on every call; Codex, Grok and z.ai send nothing of
   * the kind — checked across each stream. So for those the pool round-robins and learns nothing, and
   * saying it "spills to the next when one is nearly out" would promise a behaviour that cannot occur.
   */
  if (kind === "claude") io.log(`One nearly out of quota steps aside for the others.`);
  else io.log(`${kind} reports no quota figures, so a spent account is discovered by being refused, not before.`);
  /**
   * z.ai names nobody, so the same key can be added twice — and two entries drawing on one subscription look
   * like added capacity while being none. Every other CLI reports an address or a method and is caught above.
   */
  if (kind === "zai" && mine.length > 1) {
    io.log(`z.ai reports no account identity, so this cannot be checked: if that key is one already connected, remove the duplicate from ~/.horsecode/config.json.`);
  }
  return 0;
}
