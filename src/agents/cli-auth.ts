import { spawnSync } from "node:child_process";
import type { CliKind } from "./cli-agent.js";

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
 * Two different variables for two different binaries, each verified against the real thing: an empty
 * directory makes `claude auth status` report `loggedIn: false` and `codex login status` print
 * "Not logged in", while the ambient login answers normally in both. Nothing is shared between them — a
 * Claude profile says nothing about Codex, which is why an account carries the kind it belongs to.
 */
export function profileEnv(kind: CliKind, configDir?: string): Record<string, string> {
  if (!configDir) return {}; // the ambient login: say nothing, and the CLI finds the session it always uses
  return kind === "claude" ? { CLAUDE_CONFIG_DIR: configDir } : { CODEX_HOME: configDir };
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
 * whatever it says it used, and it offers no address to report. Both were run to see, rather than assumed.
 */
export function readAuthStatus(kind: CliKind, out: string): AuthStatus {
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

/** The status command each CLI answers. */
export function statusArgs(kind: CliKind): string[] {
  return kind === "claude" ? ["auth", "status"] : ["login", "status"];
}

/** The login command each CLI runs. Interactive by nature: it opens a browser and waits for a person. */
export function loginArgs(kind: CliKind): string[] {
  return kind === "claude" ? ["auth", "login"] : ["login"];
}

/** Runs a CLI's status command under one profile and reads the answer. */
export function checkProfile(kind: CliKind, configDir?: string): AuthStatus {
  const r = spawnSync(kind, statusArgs(kind), {
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
  const r = spawnSync(kind, loginArgs(kind), {
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
