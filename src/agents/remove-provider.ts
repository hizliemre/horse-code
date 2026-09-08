import { CLI_KINDS, type CliKind } from "./cli-agent.js";
import { accountsIn, type AccountEntry } from "./add-provider.js";
import { readingKey, type UsageStore } from "./cli-accounts.js";

/**
 * `hcode remove-provider <cli> [name]` — disconnecting a subscription.
 *
 * The counterpart `add-provider` should always have had. Without it the only way to take an account off the
 * board was to hand-edit `~/.horsecode/config.json` — a file that also holds the API key and every role
 * chain, so the remedy for "I connected the wrong account" was to open the one file where a slip is
 * expensive.
 *
 * Two things are removed, and they are not the same kind of thing. The config ENTRY is bookkeeping: dropping
 * it stops the pool handing that account out, and it is trivially undone by connecting again. The profile
 * DIRECTORY holds an actual sign-in — an OAuth session for three of the CLIs, a bearer token for z.ai — and
 * deleting it cannot be undone from here. So the entry goes without ceremony and the directory is offered,
 * never assumed.
 */

/** What the command did, so the caller can report it without re-deriving anything. */
export interface RemoveResult {
  code: number;
  /** The account that was removed, when one was. */
  removed?: AccountEntry;
}

export interface RemoveProviderIO {
  home: string;
  readConfig: () => Record<string, unknown>;
  writeConfig: (config: Record<string, unknown>) => void;
  /** Deletes a profile directory. Only ever called for a path under the profiles tree — see `ownedProfile`. */
  removeDir: (dir: string) => void;
  /** Asks before deleting a sign-in. Answering anything but yes leaves the directory alone. */
  confirm: (question: string) => boolean;
  /** Where quota readings live — a file of its own, beside the config rather than inside it. */
  usage?: UsageStore;
  log: (line: string) => void;
}

/**
 * Whether horse-code created this directory, and may therefore delete it.
 *
 * `freshDir` puts every profile it makes under `~/.horsecode/profiles/`. Anything else was named by a person
 * — a hand-written config could point an account at `~/.claude`, which holds the session they use every day
 * — and this command must not remove a directory it did not create. The check is on the resolved prefix
 * rather than on a substring, so a path merely CONTAINING that text does not qualify.
 */
export function ownedProfile(home: string, dir: string | undefined): boolean {
  if (!dir) return false;
  const root = `${home}/.horsecode/profiles/`;
  return dir.startsWith(root) && dir.length > root.length && !dir.slice(root.length).includes("..");
}

/** How an account is named on the board — the address when its CLI gave one, else the profile's own name. */
export function describeAccount(a: AccountEntry): string {
  const who = a.email ?? a.name;
  return `${a.kind} ${who}${a.plan ? ` (${a.plan})` : ""}${a.configDir ? "" : " — the signed-in default"}`;
}

/**
 * Finds the one account meant, or explains why it cannot be certain.
 *
 * A name is optional when a kind has exactly one account, because that is the ordinary case and making
 * someone type a generated name like `zai-2` to remove their only z.ai account is friction for nothing. With
 * several, guessing would disconnect the wrong subscription, so it asks.
 */
export function pickAccount(
  accounts: readonly AccountEntry[], kind: CliKind, name?: string,
): { account: AccountEntry } | { error: string } {
  const mine = accounts.filter((a) => a.kind === kind);
  if (!mine.length) return { error: `no ${kind} account is connected` };
  if (!name) {
    if (mine.length === 1) return { account: mine[0] };
    return {
      error: `${mine.length} ${kind} accounts are connected — name the one to remove:\n`
        + mine.map((a) => `  ${a.name}${a.email && a.email !== a.name ? ` (${a.email})` : ""}`).join("\n"),
    };
  }
  // Either the name it is filed under or the address it reports — a person reads the address off the
  // start-up line and has no reason to know the other one exists.
  const found = mine.filter((a) => a.name === name || a.email === name);
  if (!found.length) {
    return {
      error: `no ${kind} account called "${name}". Connected:\n`
        + mine.map((a) => `  ${a.name}${a.email && a.email !== a.name ? ` (${a.email})` : ""}`).join("\n"),
    };
  }
  if (found.length > 1) return { error: `"${name}" matches ${found.length} ${kind} accounts — remove one by its exact name` };
  return { account: found[0] };
}

/** Disconnect one subscription. Returns the process exit code. */
export function removeProvider(kind: CliKind, name: string | undefined, io: RemoveProviderIO): RemoveResult {
  const config = io.readConfig();
  const accounts = accountsIn(config);
  const picked = pickAccount(accounts, kind, name);
  if ("error" in picked) {
    io.log(picked.error);
    const others = accounts.filter((a) => a.kind !== kind);
    if (!accounts.filter((a) => a.kind === kind).length && others.length) {
      io.log(`\nConnected accounts:\n${others.map((a) => `  ${describeAccount(a)}`).join("\n")}`);
    }
    return { code: 1 };
  }
  const account = picked.account;

  const kept = accounts.filter((a) => a !== account);
  /**
   * Spread first, so every other setting — `apiKey` above all — is carried through untouched. The same rule
   * `add-provider` follows, and for the same reason: this is setup, and setup that silently drops somebody
   * else's credential is worse than no command.
   */
  io.writeConfig({ ...config, accounts: kept });
  /**
   * The quota reading goes with it, and it lives in a file of its own (`~/.horsecode/usage.json`), not in
   * the config. Readings are filed under `kind:name`, so leaving one behind means an account later connected
   * under the same generated name — `zai-2` is handed out again the moment the first one is gone — inherits
   * a figure describing a subscription that is no longer there. The start-up line would date it honestly and
   * still be describing somebody else.
   */
  if (io.usage) {
    const readings = io.usage.load();
    const { [readingKey(kind, account.name)]: _dropped, ...rest } = readings;
    io.usage.save(rest);
  }
  io.log(`Removed ${describeAccount(account)}.`);

  if (!account.configDir) {
    /**
     * The signed-in default is DISCOVERED, not stored, so removing its entry is close to a no-op: the next
     * start-up asks each CLI who it is logged in as and pools the answer again. Saying so prevents the
     * obvious wrong conclusion — that this signed anybody out.
     */
    io.log(`That was the account you are signed into ${kind} with, not a profile horse-code created.`);
    io.log(`It is still signed in, and a run will find it again. To stop using it, sign out of ${kind} itself.`);
    return { code: 0, removed: account };
  }

  if (!ownedProfile(io.home, account.configDir)) {
    // A directory named by hand may be the session somebody uses every day. Reported, never touched.
    io.log(`Its profile at ${account.configDir} was not created by horse-code, so it is left alone.`);
    return { code: 0, removed: account };
  }

  const holds = kind === "zai" ? "the API key" : `the ${kind} sign-in`;
  if (!io.confirm(`Also delete ${account.configDir}, which holds ${holds}?`)) {
    io.log(`Left ${account.configDir} in place. Delete it by hand to remove ${holds}.`);
    return { code: 0, removed: account };
  }
  io.removeDir(account.configDir);
  io.log(`Deleted ${account.configDir}.`);
  return { code: 0, removed: account };
}

/** The message for a missing or unrecognised CLI name, shared with `add-provider`'s. */
export function removeUsage(given?: string): string {
  return `remove-provider needs a CLI to disconnect: ${CLI_KINDS.map((k) => `\`hcode remove-provider ${k}\``).join(", ")}`
    + `${given ? ` (got "${given}")` : ""}`;
}
