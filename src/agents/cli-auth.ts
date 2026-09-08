import { spawnSync } from "node:child_process";
import { cliBinary, type CliKind } from "./cli-agent.js";

/**
 * Asking a CLI who it is logged in as, and sending a person through its own login.
 *
 * horse-code never authenticates anything. Both CLIs own their sign-in — a browser, an account chooser, an
 * approval — and each already knows how to do it. What is added here is only WHERE: a profile directory the
 * CLI has not been pointed at before, so the session it creates lands beside the others instead of replacing
 * the one already there.
 *
 * Nothing in this file reads, stores, or transports a credential. It sets an environment variable naming a
 * directory, runs the CLI's own command, and afterwards asks the CLI what it thinks.
 */

/**
 * The environment that points a CLI at one profile.
 *
 * A different variable per binary, each verified against the real thing: pointed at an empty directory,
 * `claude auth status` reports `loggedIn: false`, `codex login status` prints "Not logged in", and
 * `grok models` prints "You are not authenticated." — while the ambient login answers normally in all
 * three. Nothing is shared between them: a Claude profile says nothing about Codex or Grok, which is why an
 * account carries the kind it belongs to.
 *
 * `GROK_HOME` was found by trying it, not by reading it in the help — Grok's `--help` names only
 * `GROK_SANDBOX`. Under a fresh directory it built its own tree there (`config.toml`, `sessions/`, `logs/`,
 * `agent_id`) and reported itself signed out, which is the same behaviour the other two show and the whole
 * requirement for a second subscription.
 */
export function profileEnv(kind: CliKind, configDir?: string): Record<string, string> {
  if (!configDir) return {}; // the ambient login: say nothing, and the CLI finds the session it always uses
  /**
   * z.ai uses Claude Code's own variable, because it IS Claude Code. What makes the profile a z.ai one is
   * the `settings.json` inside it, whose `env` block names z.ai's endpoint and carries the token — measured
   * to be honoured, and the reason no credential passes through this function. See `zai-profile.ts`.
   */
  if (kind === "claude" || kind === "zai") return { CLAUDE_CONFIG_DIR: configDir };
  if (kind === "codex") return { CODEX_HOME: configDir };
  return { GROK_HOME: configDir };
}

/** Who a profile is logged in as, in the terms its own CLI uses. */
export interface AuthStatus {
  loggedIn: boolean;
  /** The account, when the CLI names one. Codex reports the method without an address. */
  email?: string;
  /** The subscription as the CLI describes it — `max`, `pro`, `ChatGPT`. */
  plan?: string;
}

/**
 * What each CLI is asked, and how its answer is read.
 *
 * Claude answers `auth status` with JSON carrying `loggedIn`, `email` and `subscriptionType`. Codex answers
 * `login status` with one line of prose — "Logged in using ChatGPT" or "Not logged in" — so its plan is
 * whatever it says it used, and it offers no address to report. All three were run to see, rather than
 * assumed.
 *
 * Grok has no status command at all: `grok login --help` offers only `--oauth` and `--device-auth`, and
 * `grok doctor` reports the terminal, the clipboard and the microphone without ever mentioning an account.
 * What does say is `grok models`, whose first line is "You are logged in with grok.com." or "You are not
 * authenticated." — so that is what is asked. The exit code is 0 EITHER WAY, measured, which is why the text
 * is read rather than the status: a check on the exit code would call every signed-out profile connected.
 */
export function readAuthStatus(kind: CliKind, out: string): AuthStatus {
  if (kind === "grok") {
    // Grok names the identity provider it signed in through and no address, so — as with Codex — the plan is
    // the only identity there is.
    const m = /you are logged in with\s+(.+)/i.exec(out);
    if (!m) return { loggedIn: false };
    // The trailing period is the sentence's, not the name's — and the name has periods of its own
    // ("grok.com"), so it cannot simply be read up to the first one.
    const plan = m[1].trim().replace(/\.$/, "");
    return { loggedIn: true, ...(plan ? { plan } : {}) };
  }
  if (kind === "codex") {
    const m = /logged in(?: using (.+))?/i.exec(out);
    // "Not logged in" contains "logged in" — the negation has to be checked first, or every profile
    // reports itself connected and `add-provider` congratulates someone who never signed in.
    if (!m || /not logged in/i.test(out)) return { loggedIn: false };
    const plan = m[1]?.trim();
    return { loggedIn: true, ...(plan ? { plan } : {}) };
  }
  try {
    const j = JSON.parse(out) as { loggedIn?: boolean; email?: string; subscriptionType?: string };
    if (!j.loggedIn) return { loggedIn: false };
    return {
      loggedIn: true,
      ...(j.email ? { email: j.email } : {}),
      ...(j.subscriptionType ? { plan: j.subscriptionType } : {}),
    };
  } catch {
    // A CLI that answered with something unparseable has told us nothing, and guessing "logged in" here
    // would write a broken profile into the config as though it worked.
    return { loggedIn: false };
  }
}

/** The status command each CLI answers. Grok has none, so its model list is asked instead — see above. */
export function statusArgs(kind: CliKind): string[] {
  if (kind === "claude" || kind === "zai") return ["auth", "status"];
  if (kind === "codex") return ["login", "status"];
  return ["models"];
}

/** The login command each CLI runs. Interactive by nature: it opens a browser and waits for a person. */
export function loginArgs(kind: CliKind): string[] {
  return kind === "claude" ? ["auth", "login"] : ["login"];
}

/**
 * Runs a CLI's status command under one profile and reads the answer.
 *
 * Worth knowing what this CANNOT answer, because the words it returns overstate it: for a z.ai profile
 * `auth status` reports `loggedIn: true` whenever a token is present, valid or not — measured against a
 * control with the token "totally-bogus". Connecting one is confirmed by a real call instead; see
 * `verifyZaiProfile`.
 */
export function checkProfile(kind: CliKind, configDir?: string): AuthStatus {
  /**
   * There is no ambient z.ai, and asking anyway returns SOMEBODY ELSE'S ACCOUNT.
   *
   * A z.ai profile is a Claude Code directory pointed at another endpoint, so with no directory named this
   * runs plain `claude auth status` — which answers with the person's own Anthropic session, address, plan
   * and all. Observed exactly that while wiring this up: a probe that asked every kind ambiently printed the
   * signed-in Anthropic address and its plan on the `zai` row, that subscription wearing z.ai's name.
   * Pooled, it would send z.ai's turn to Anthropic and file the spend there.
   *
   * The caller that builds the start-up summary also skips z.ai, so no process is spawned for it at all.
   * This is the guard underneath that one: a future caller which forgets gets a truthful "not connected"
   * rather than a confident wrong answer.
   */
  if (kind === "zai" && !configDir) return { loggedIn: false };
  const r = spawnSync(cliBinary(kind), statusArgs(kind), {
    env: { ...process.env, ...profileEnv(kind, configDir) },
    encoding: "utf8",
    // A status check that hangs must not hang the startup summary with it.
    timeout: 20_000,
  });
  if (r.error) return { loggedIn: false };
  return readAuthStatus(kind, `${r.stdout ?? ""}${r.stderr ?? ""}`);
}

/**
 * Hands the terminal to the CLI's own login, pointed at one profile.
 *
 * `stdio: "inherit"` is the whole mechanism: the person sees the CLI's real prompts and its real browser
 * hand-off, and answers them directly. horse-code is not in the middle of that exchange and never sees what
 * passes through it — it set a directory beforehand and asks the CLI afterwards whether it worked.
 */
export function runLogin(kind: CliKind, configDir?: string): { ok: boolean; error?: string } {
  /**
   * z.ai has no sign-in to hand the terminal to, and running Claude Code's would be actively wrong: it would
   * open ANTHROPIC's OAuth and write an Anthropic session into a directory meant to hold a z.ai token.
   * Measured: a z.ai profile needs no login at all — a directory containing only the settings file produced
   * an authenticated request. Connecting one writes that file; see `writeZaiProfile`.
   */
  if (kind === "zai") {
    return { ok: false, error: "z.ai has no sign-in — a profile is connected by writing its settings file" };
  }
  const r = spawnSync(cliBinary(kind), loginArgs(kind), {
    env: { ...process.env, ...profileEnv(kind, configDir) },
    stdio: "inherit",
  });
  if (r.error) {
    const e = r.error as NodeJS.ErrnoException;
    return e.code === "ENOENT"
      ? { ok: false, error: `\`${kind}\` is not installed, or not on PATH` }
      : { ok: false, error: e.message };
  }
  return { ok: r.status === 0 };
}
