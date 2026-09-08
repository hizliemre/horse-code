import { describe, it, expect } from "vitest";
import { addProvider, withAmbient, freshDir, accountsIn } from "../../src/agents/add-provider.js";
import type { AddProviderIO, AccountEntry } from "../../src/agents/add-provider.js";
import type { AuthStatus } from "../../src/agents/cli-auth.js";
import { readAuthStatus, profileEnv, statusArgs } from "../../src/agents/cli-auth.js";
import { accountsLine, ageOf } from "../../src/agents/cli-accounts.js";

const HOME = "/home/u";

interface Fake extends AddProviderIO {
  written?: Record<string, unknown>;
  lines: string[];
  loggedInto: string[];
}

function fake(over: Partial<AddProviderIO> & { config?: Record<string, unknown>; status?: Record<string, AuthStatus> } = {}): Fake {
  const status = over.status ?? {};
  const io: Fake = {
    home: HOME,
    lines: [],
    loggedInto: [],
    readConfig: () => over.config ?? {},
    writeConfig: (c) => { io.written = c; },
    login: (_k, dir) => { io.loggedInto.push(dir ?? "(ambient)"); return { ok: true }; },
    check: (_k, dir) => status[dir ?? "(ambient)"] ?? { loggedIn: false },
    log: (l) => { io.lines.push(l); },
    ...over,
  };
  return io;
}

/**
 * The trap this whole flow exists to avoid.
 *
 * The pool only offers profiles it knows about. Connect a second subscription without recording the one the
 * person has been using all along, and every call goes to the new profile while the original sits idle —
 * connecting a second account would have QUIETLY RETIRED the first.
 */
describe("not losing the subscription already in use", () => {
  /**
   * Recorded WITHOUT a directory, and that is the whole point. Claude Code keeps its ambient session in the
   * Keychain, and setting `CLAUDE_CONFIG_DIR` at all switches it to file credentials in that directory — so
   * an entry naming `~/.claude`, the obvious guess, reports logged out and fails every call handed to it.
   */
  it("records the ambient login as a profile with no directory", () => {
    const out = withAmbient("claude", [], { loggedIn: true, email: "a@x.com", plan: "max" });
    expect(out).toEqual([{ kind: "claude", name: "a@x.com", email: "a@x.com", plan: "max" }]);
    expect(out[0]).not.toHaveProperty("configDir");
  });

  it("does not record it again once a profile of that kind exists", () => {
    const existing: AccountEntry[] = [{ kind: "claude", name: "a@x.com" }];
    expect(withAmbient("claude", existing, { loggedIn: true, email: "a@x.com" })).toEqual(existing);
  });

  it("records nothing when nobody is signed in ambiently", () => {
    expect(withAmbient("codex", [], { loggedIn: false })).toEqual([]);
  });

  /** Adding a Codex account must not conclude the Claude one covers it — they are separate sign-ins. */
  it("looks only at its own kind", () => {
    const existing: AccountEntry[] = [{ kind: "claude", name: "a@x.com" }];
    const out = withAmbient("codex", existing, { loggedIn: true, plan: "ChatGPT" });
    expect(out.map((a) => a.kind)).toEqual(["claude", "codex"]);
    expect(out.at(-1)?.plan).toBe("ChatGPT");
  });
});

describe("choosing a directory for the new profile", () => {
  it("skips every directory already spoken for", () => {
    const taken: AccountEntry[] = [
      { kind: "claude", name: "a" },
      { kind: "claude", name: "b", configDir: `${HOME}/.horsecode/profiles/claude-2` },
    ];
    expect(freshDir("claude", HOME, taken)).toBe(`${HOME}/.horsecode/profiles/claude-3`);
  });

  it("never proposes a CLI's own default directory, which holds somebody's existing session", () => {
    const proposed = freshDir("claude", HOME, []);
    expect(proposed).not.toBe(`${HOME}/.claude`);
    expect(proposed).toBe(`${HOME}/.horsecode/profiles/claude-2`);
  });
});

describe("connecting a subscription", () => {
  const newDir = `${HOME}/.horsecode/profiles/claude-2`;

  it("writes the account only after the CLI confirms a real session", () => {
    const io = fake({
      status: {
        "(ambient)": { loggedIn: true, email: "first@x.com", plan: "max" },
        [newDir]: { loggedIn: true, email: "second@x.com", plan: "max" },
      },
    });
    expect(addProvider("claude", io)).toBe(0);
    expect(io.loggedInto).toEqual([newDir]);
    expect(io.written?.accounts).toEqual([
      { kind: "claude", name: "first@x.com", email: "first@x.com", plan: "max" },
      { kind: "claude", name: "second@x.com", configDir: newDir, email: "second@x.com", plan: "max" },
    ]);
  });

  /**
   * Everything else in that file has to survive, `apiKey` above all: this command is setup, and setup that
   * silently drops a credential someone else put there is worse than no command.
   */
  it("leaves the rest of the config untouched", () => {
    const io = fake({
      config: { apiKey: "sk-keep-me", model: "opus", mcp: { x: { url: "http://y" } } },
      status: { [newDir]: { loggedIn: true, email: "s@x.com" } },
    });
    addProvider("claude", io);
    expect(io.written?.apiKey).toBe("sk-keep-me");
    expect(io.written?.model).toBe("opus");
    expect(io.written?.mcp).toEqual({ x: { url: "http://y" } });
  });

  /**
   * A profile written on optimism gets PICKED for real work and fails every call it is given. Nothing is
   * recorded unless the CLI itself says there is a session.
   */
  it("changes nothing when the sign-in is abandoned", () => {
    const io = fake({ login: () => ({ ok: false, error: "cancelled" }) });
    expect(addProvider("claude", io)).toBe(1);
    expect(io.written).toBeUndefined();
  });

  /**
   * A real refusal came back as `error=access_denied&error_description=account_on_hold` on the OAuth
   * callback — visible only in the browser. The CLI reported just that no code arrived, and horse-code sees
   * even less. Without this line someone debugs the command while the answer sits in the address bar.
   */
  it("says where the reason for a refused sign-in actually is", () => {
    const io = fake({ login: () => ({ ok: false }) });
    addProvider("claude", io);
    const said = io.lines.join("\n");
    expect(said).toContain("address holds the reason");
    expect(said).toContain("Nothing needs cleaning up");
  });

  it("changes nothing when the CLI still reports no session afterwards", () => {
    const io = fake({ status: {} });
    expect(addProvider("claude", io)).toBe(1);
    expect(io.written).toBeUndefined();
  });

  /**
   * Two entries for one account would look like added capacity while both draw down a single limit — a run
   * would believe it had somewhere to spill to and find the same exhausted subscription waiting.
   */
  it("refuses to file the same account twice", () => {
    const io = fake({
      config: { accounts: [{ kind: "claude", name: "same@x.com", email: "same@x.com" }] },
      status: { [newDir]: { loggedIn: true, email: "same@x.com" } },
    });
    expect(addProvider("claude", io)).toBe(1);
    expect(io.written).toBeUndefined();
    expect(io.lines.join("\n")).toContain("already connected");
  });

  it("ignores malformed entries rather than failing on them", () => {
    expect(accountsIn({ accounts: [{ kind: "nope" }, 7, { kind: "codex", name: "a", configDir: "/d" }] }))
      .toEqual([{ kind: "codex", name: "a", configDir: "/d" }]);
    // An entry with no directory is the ambient login, not a malformed row.
    expect(accountsIn({ accounts: [{ kind: "claude", name: "a" }] })).toEqual([{ kind: "claude", name: "a" }]);
    expect(accountsIn({})).toEqual([]);
  });
});

/**
 * Each CLI answers a different way, and both answers were read off the real binaries rather than assumed.
 */
describe("reading what a CLI says about its session", () => {
  it("reads Claude's JSON", () => {
    const out = readAuthStatus("claude", '{"loggedIn":true,"email":"a@x.com","subscriptionType":"max"}');
    expect(out).toEqual({ loggedIn: true, email: "a@x.com", plan: "max" });
    expect(readAuthStatus("claude", '{"loggedIn":false,"authMethod":"none"}')).toEqual({ loggedIn: false });
  });

  it("reads Codex's one line", () => {
    expect(readAuthStatus("codex", "Logged in using ChatGPT\n")).toEqual({ loggedIn: true, plan: "ChatGPT" });
  });

  /** "Not logged in" contains "logged in" — read carelessly, every profile reports itself connected. */
  it("does not read a refusal as a session", () => {
    expect(readAuthStatus("codex", "Not logged in")).toEqual({ loggedIn: false });
  });

  it("treats an unparseable answer as no session rather than guessing", () => {
    expect(readAuthStatus("claude", "<html>gateway error</html>")).toEqual({ loggedIn: false });
  });

  /**
   * Grok has no status command at all — `grok login --help` offers only `--oauth` and `--device-auth`, and
   * `grok doctor` reports the terminal and the microphone without ever mentioning an account. `grok models`
   * is what answers, and this is its real first line.
   */
  it("reads Grok's model listing, which is the only thing that names its session", () => {
    const out = readAuthStatus("grok", "You are logged in with grok.com.\n\nDefault model: grok-4.6\n");
    expect(out).toEqual({ loggedIn: true, plan: "grok.com" });
  });

  /**
   * The exit code is 0 EITHER WAY, measured on both a signed-in and a signed-out profile. So the text is the
   * only signal there is: checked on the status instead, every signed-out profile would report itself
   * connected and be handed real work.
   */
  it("reads Grok's refusal, which exits successfully all the same", () => {
    expect(readAuthStatus("grok", "You are not authenticated.\n\nDefault model: grok-4.6\n"))
      .toEqual({ loggedIn: false });
  });
});

/**
 * Each CLI keeps its session under a directory of its own, and the variable that names it differs per
 * binary. `GROK_HOME` was found by trying it — Grok's `--help` names only `GROK_SANDBOX` — and under a fresh
 * directory it built its own tree there and reported itself signed out, exactly as the other two do.
 */
describe("pointing a CLI at one profile", () => {
  it("asks each CLI the question it can actually answer", () => {
    expect(statusArgs("claude")).toEqual(["auth", "status"]);
    expect(statusArgs("codex")).toEqual(["login", "status"]);
    expect(statusArgs("grok")).toEqual(["models"]);
  });

  it("names each CLI's own variable", () => {
    expect(profileEnv("claude", "/p/c")).toEqual({ CLAUDE_CONFIG_DIR: "/p/c" });
    expect(profileEnv("codex", "/p/x")).toEqual({ CODEX_HOME: "/p/x" });
    expect(profileEnv("grok", "/p/g")).toEqual({ GROK_HOME: "/p/g" });
  });

  /**
   * The ambient login is expressed as ABSENCE, for every kind. Claude's is in the macOS Keychain and setting
   * `CLAUDE_CONFIG_DIR` at all switches it to file credentials — so naming the default directory reports
   * logged out for someone who plainly is not.
   */
  it("says nothing at all for the login already in use", () => {
    for (const kind of ["claude", "codex", "grok"] as const) expect(profileEnv(kind)).toEqual({});
  });
});

/**
 * The line answers what a run will USE. A first version listed only pooled profiles, so someone signed into
 * both CLIs and perfectly able to run saw nothing and reasonably concluded no account was connected.
 *
 * Every figure carries its age, because none is current: a reading arrives with a call and says nothing about
 * what happened after. Printed bare, "42%" reads as a fact about now rather than about whenever that profile
 * was last used — which for a spare subscription can be days.
 */
describe("the start-up account line", () => {
  const now = 10_000_000;

  it("says nothing when there is nothing to say at all", () => {
    expect(accountsLine([])).toBeUndefined();
  });

  it("names each pooled profile and dates its figure", () => {
    const out = accountsLine(
      [
        { account: { kind: "claude", name: "a", configDir: "/1", email: "a@x.com", plan: "max" }, reading: { spent: 0.42, at: now - 720_000 } },
        { account: { kind: "claude", name: "b", configDir: "/2", email: "b@x.com", plan: "max" } },
      ],
      [],
      now,
    );
    expect(out).toBe("claude a@x.com (max) 42% used 12m ago · claude b@x.com (max)");
  });

  /**
   * The signed-in default is an ordinary pool member with no directory, which is what lets its readings be
   * kept. Held outside the pool, every reading a run produced was discarded and the line could never show
   * what any subscription had left — most of what it exists for.
   */
  it("shows a signed-in default, which is a pooled profile with no directory", () => {
    const out = accountsLine([{ account: { kind: "claude", name: "a@x.com", email: "a@x.com", plan: "max" } }], [], now);
    expect(out).toBe("claude a@x.com (max)");
  });

  /** The most useful entry here: every call routed there fails, and that is better learned before a run. */
  it("says plainly when a CLI has nobody signed in", () => {
    expect(accountsLine([], ["codex"], now)).toBe("codex NOT signed in — every codex call will fail");
  });

  /** Codex reports a method and no address, so there the method is the only identity there is to print. */
  it("names a CLI that reports no address by what it signed in with", () => {
    expect(accountsLine([{ account: { kind: "codex", name: "codex-default", plan: "ChatGPT" } }], [], now))
      .toBe("codex ChatGPT");
  });

  it("puts every subscription on one line", () => {
    const out = accountsLine(
      [
        { account: { kind: "claude", name: "a", configDir: "/1", email: "a@x.com" } },
        { account: { kind: "codex", name: "codex-default", plan: "ChatGPT" } },
      ],
      [],
      now,
    );
    expect(out).toBe("claude a@x.com · codex ChatGPT");
  });

  it("scales an age to something a person reads at a glance", () => {
    expect(ageOf(now - 300_000, now)).toBe("5m");
    expect(ageOf(now - 10_800_000, now)).toBe("3h");
    expect(ageOf(now - 259_200_000, now)).toBe("3d");
  });
});
