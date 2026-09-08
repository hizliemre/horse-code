import { describe, it, expect } from "vitest";
import {
  removeProvider, pickAccount, ownedProfile, describeAccount, removeUsage,
} from "../../src/agents/remove-provider.js";
import type { RemoveProviderIO } from "../../src/agents/remove-provider.js";
import type { AccountEntry } from "../../src/agents/add-provider.js";
import type { Reading, UsageStore } from "../../src/agents/cli-accounts.js";

const HOME = "/home/u";
const profile = (n: string): string => `${HOME}/.horsecode/profiles/${n}`;

interface Fake extends RemoveProviderIO {
  written?: Record<string, unknown>;
  removedDirs: string[];
  lines: string[];
  readings: Record<string, Reading>;
  /** What the chooser was offered, so a test can assert the person saw the right accounts. */
  offered: string[];
}

function fake(config: Record<string, unknown>, over: Partial<RemoveProviderIO> & { readings?: Record<string, Reading> } = {}): Fake {
  const io: Fake = {
    home: HOME,
    removedDirs: [],
    lines: [],
    offered: [],
    readings: over.readings ?? {},
    readConfig: () => config,
    writeConfig: (c) => { io.written = c; },
    removeDir: (d) => { io.removedDirs.push(d); },
    confirm: () => true,
    // No terminal is the default, so a test that does not opt in cannot silently remove an unnamed account.
    choose: (_q, options) => { io.offered = [...options]; return undefined; },
    log: (l) => { io.lines.push(l); },
    ...over,
  };
  const store: UsageStore = { load: () => io.readings, save: (r) => { io.readings = r; } };
  io.usage = store;
  return io;
}

const said = (io: Fake): string => io.lines.join("\n");

describe("naming the account to disconnect", () => {
  const accounts: AccountEntry[] = [
    { kind: "claude", name: "a@x.com", email: "a@x.com", plan: "max" },
    { kind: "zai", name: "zai-2", configDir: profile("zai-2") },
    { kind: "zai", name: "zai-3", configDir: profile("zai-3") },
  ];

  /** The ordinary case: one account of that kind, so making somebody type `zai-2` would be friction. */
  it("needs no name when a kind has exactly one account", () => {
    expect(pickAccount(accounts, "claude")).toEqual({ account: accounts[0] });
  });

  /**
   * With several it neither guesses nor gives up: the set comes back for the caller to ask about. Giving up
   * — printing the list and exiting, which this did at first — made a person read the names, re-type one and
   * run the command again to reach a question the program was already able to ask.
   */
  it("hands back the set to choose from when a kind has several", () => {
    expect(pickAccount(accounts, "zai")).toEqual({ choices: [accounts[1], accounts[2]] });
  });

  it("takes the name it is filed under", () => {
    expect(pickAccount(accounts, "zai", "zai-3")).toEqual({ account: accounts[2] });
  });

  /**
   * Or the address, which is what the start-up line shows — somebody reads "claude a@x.com" off the panel
   * and has no reason to know a separate internal name exists.
   */
  it("also takes the address the CLI reports", () => {
    expect(pickAccount(accounts, "claude", "a@x.com")).toEqual({ account: accounts[0] });
  });

  it("says so when the kind has nothing connected, or the name matches nothing", () => {
    expect(pickAccount(accounts, "codex")).toEqual({ error: "no codex account is connected" });
    const r = pickAccount(accounts, "zai", "zai-9");
    expect((r as { error: string }).error).toContain('no zai account called "zai-9"');
  });
});

/**
 * The boundary that keeps this command from deleting somebody's daily session.
 *
 * `freshDir` puts every profile horse-code makes under `~/.horsecode/profiles/`. A hand-written config can
 * point an account anywhere — `~/.claude` holds the session they use every day — and this must never remove
 * a directory it did not create.
 */
describe("which directories may be deleted", () => {
  it("claims only the profiles horse-code created", () => {
    expect(ownedProfile(HOME, profile("zai-2"))).toBe(true);
    expect(ownedProfile(HOME, `${HOME}/.claude`)).toBe(false);
    expect(ownedProfile(HOME, "/etc")).toBe(false);
    expect(ownedProfile(HOME, undefined)).toBe(false);
  });

  /** The tree itself is not a profile, and a traversal out of it is not one either. */
  it("refuses the profiles root and anything escaping it", () => {
    expect(ownedProfile(HOME, `${HOME}/.horsecode/profiles/`)).toBe(false);
    expect(ownedProfile(HOME, `${HOME}/.horsecode/profiles/../../.ssh`)).toBe(false);
  });
});

describe("disconnecting one", () => {
  const zai: AccountEntry = { kind: "zai", name: "zai-2", configDir: profile("zai-2") };

  it("drops the entry and leaves every other setting alone", () => {
    const io = fake({ apiKey: "sk-keep-me", roles: { coder: 1 }, accounts: [zai] });
    expect(removeProvider("zai", undefined, io).code).toBe(0);
    expect(io.written?.accounts).toEqual([]);
    expect(io.written?.apiKey).toBe("sk-keep-me");
    expect(io.written?.roles).toEqual({ coder: 1 });
  });

  it("keeps the accounts it was not asked about", () => {
    const other: AccountEntry = { kind: "claude", name: "a@x.com", email: "a@x.com" };
    const io = fake({ accounts: [other, zai] });
    removeProvider("zai", "zai-2", io);
    expect(io.written?.accounts).toEqual([other]);
  });

  /**
   * A reading left behind is inherited by whatever is connected next under the same generated name — and
   * `zai-2` is handed out again the moment the first one is gone. The start-up line would date the figure
   * honestly while it describes a subscription that is no longer there.
   */
  it("forgets the account's quota reading", () => {
    const io = fake({ accounts: [zai] }, {
      readings: { "zai:zai-2": { spent: 0.4, at: 1 }, "claude:a@x.com": { spent: 0.1, at: 2 } },
    });
    removeProvider("zai", "zai-2", io);
    expect(Object.keys(io.readings)).toEqual(["claude:a@x.com"]);
  });

  /** The sign-in is the part that cannot be undone from here, so it is offered rather than assumed. */
  it("deletes the profile only when the person says yes", () => {
    const io = fake({ accounts: [zai] });
    removeProvider("zai", "zai-2", io);
    expect(io.removedDirs).toEqual([profile("zai-2")]);
  });

  it("leaves the profile in place when they decline, and says where it is", () => {
    const io = fake({ accounts: [zai] }, { confirm: () => false });
    removeProvider("zai", "zai-2", io);
    expect(io.removedDirs).toEqual([]);
    expect(said(io)).toContain(profile("zai-2"));
    // Removed from the board either way — declining the deletion does not undo the disconnection.
    expect(io.written?.accounts).toEqual([]);
  });

  /** What it holds differs, and the question should say which — a key is not a browser session. */
  it("names what the directory actually holds", () => {
    const zaiIo = fake({ accounts: [zai] }, { confirm: (q) => { zaiIo.lines.push(q); return false; } });
    removeProvider("zai", "zai-2", zaiIo);
    expect(said(zaiIo)).toContain("the API key");

    const cc: AccountEntry = { kind: "claude", name: "claude-2", configDir: profile("claude-2") };
    const ccIo = fake({ accounts: [cc] }, { confirm: (q) => { ccIo.lines.push(q); return false; } });
    removeProvider("claude", "claude-2", ccIo);
    expect(said(ccIo)).toContain("the claude sign-in");
  });

  it("never touches a directory horse-code did not create", () => {
    const byHand: AccountEntry = { kind: "claude", name: "mine", configDir: `${HOME}/.claude` };
    const io = fake({ accounts: [byHand] });
    removeProvider("claude", "mine", io);
    expect(io.removedDirs).toEqual([]);
    expect(said(io)).toContain("not created by horse-code");
  });

  /**
   * The signed-in default is DISCOVERED at start-up, not stored, so removing its entry is close to a no-op —
   * the next run asks the CLI who it is logged in as and pools the answer again. Saying so prevents the
   * obvious wrong conclusion, that this signed anybody out.
   */
  it("explains that removing the signed-in default does not sign anyone out", () => {
    const ambient: AccountEntry = { kind: "codex", name: "codex-default", plan: "ChatGPT" };
    const io = fake({ accounts: [ambient] });
    expect(removeProvider("codex", undefined, io).code).toBe(0);
    expect(io.removedDirs).toEqual([]);
    expect(said(io)).toContain("still signed in");
  });

  /** One account of that kind: nothing to ask about, so it goes without a question. */
  it("removes the only account of its kind without asking which", () => {
    const io = fake({ accounts: [zai] });
    expect(removeProvider("zai", undefined, io).code).toBe(0);
    expect(io.offered).toEqual([]);
    expect(io.written?.accounts).toEqual([]);
  });

  describe("when a kind has more than one", () => {
    const second: AccountEntry = { kind: "zai", name: "zai-3", configDir: profile("zai-3") };

    it("asks which one, showing both", () => {
      const io = fake({ accounts: [zai, second] }, { choose: (_q, o) => { io.offered = [...o]; return 1; } });
      expect(removeProvider("zai", undefined, io).code).toBe(0);
      expect(io.offered).toEqual(["zai zai-2", "zai zai-3"]);
      expect(io.written?.accounts).toEqual([zai]);
    });

    /**
     * Cancelling removes NOTHING. Reading an unreadable answer as "they meant the first one" would
     * disconnect a subscription nobody named — the whole failure the question exists to prevent.
     */
    it("removes nothing when the question is cancelled", () => {
      const io = fake({ accounts: [zai, second] }, { choose: () => undefined });
      expect(removeProvider("zai", undefined, io).code).toBe(1);
      expect(io.written).toBeUndefined();
      expect(io.removedDirs).toEqual([]);
    });

    /** Naming one skips the question entirely — which is what a script does. */
    it("does not ask when the account was named", () => {
      const io = fake({ accounts: [zai, second] }, { choose: (_q, o) => { io.offered = [...o]; return 0; } });
      removeProvider("zai", "zai-3", io);
      expect(io.offered).toEqual([]);
      expect(io.written?.accounts).toEqual([zai]);
    });
  });

  it("changes nothing when there is no such account", () => {
    const io = fake({ accounts: [zai] });
    expect(removeProvider("claude", undefined, io).code).toBe(1);
    expect(io.written).toBeUndefined();
    expect(io.removedDirs).toEqual([]);
  });

  /** Told the kind has nothing, a person's next question is what they DO have. */
  it("lists what is connected when the named kind has nothing", () => {
    const io = fake({ accounts: [zai] });
    removeProvider("claude", undefined, io);
    expect(said(io)).toContain("zai zai-2");
  });
});

describe("how an account is described", () => {
  it("prefers the address over the internal name", () => {
    expect(describeAccount({ kind: "claude", name: "n", email: "a@x.com", plan: "max", configDir: profile("claude-2") }))
      .toBe("claude a@x.com (max)");
  });

  /**
   * No directory means the signed-in default, and the line has to say so: removing it does not sign anybody
   * out, and the next start-up will find it again.
   */
  it("marks the account that is a login rather than a profile", () => {
    expect(describeAccount({ kind: "codex", name: "codex-default", plan: "ChatGPT" }))
      .toContain("the signed-in default");
  });

  it("names every CLI in the usage line", () => {
    for (const k of ["claude", "codex", "grok", "zai"]) expect(removeUsage()).toContain(k);
    expect(removeUsage("bogus")).toContain('(got "bogus")');
  });
});
