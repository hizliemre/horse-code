import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeClaudeEvent, makeStreamReader, SYNTHETIC } from "./cli-agent.js";

/**
 * z.ai as a subscription, through the Claude Code binary it is designed to be used with.
 *
 * z.ai ships NO command-line tool of its own — checked on this machine and stated in its own documentation,
 * which describes the integration the other way round: "compatible with top coding tools like Claude Code",
 * by pointing that client at an Anthropic-compatible endpoint of theirs. So this is not a fourth binary. It
 * is the `claude` binary, run against a different endpoint, and everything already built for Claude Code —
 * the argv, the stream decoder, the profile directory, the activity strip — serves it unchanged.
 *
 * Four things were measured before any of this was written, each against the real binary and a local server
 * standing in for the endpoint, so that no z.ai key was needed to learn them:
 *
 *   1. `$CLAUDE_CONFIG_DIR/settings.json`'s `env` block IS honoured. A profile directory holding nothing but
 *      that file sent its request to the address named there. This is what lets the credential live in the
 *      profile — the very file z.ai's own instructions tell a person to write — instead of in horse-code's
 *      config, so `CliAccount` keeps naming only a path.
 *
 *   2. A model id passes STRAIGHT THROUGH. `--model glm-5.3` arrived in the request body as
 *      `"model":"glm-5.3"`, so GLM models are named the way every other model here is named. z.ai's guide
 *      recommends the `ANTHROPIC_DEFAULT_*_MODEL` mapping instead, and that advice is for someone typing
 *      `/model sonnet` interactively; a caller that names its model outright does not need it.
 *
 *   3. There is NO sign-in step. A fresh profile directory with only this settings file produced an
 *      authenticated request — no browser, no OAuth, no `claude login`. Connecting z.ai is therefore writing
 *      a file, which is why it does not go through `runLogin` like the other three.
 *
 *   4. And the trap: `claude auth status` reports `loggedIn: true` for a token that is COMPLETE NONSENSE.
 *      Measured against a control — an empty profile and a profile carrying the base URL but no token both
 *      report `loggedIn: false`, and adding the string "totally-bogus" as the token flips it to true. It is
 *      a presence check wearing the words of a validity check. So connecting a z.ai account is confirmed by
 *      a real call and never by that answer — see `verifyZaiProfile`.
 */

/** z.ai's Anthropic-compatible endpoint, from its own Claude Code guide. */
export const ZAI_BASE_URL = "https://api.z.ai/api/anthropic";

/**
 * The profile settings a z.ai account needs, and nothing else.
 *
 * Deliberately not the wider block z.ai's guide suggests. `ANTHROPIC_DEFAULT_*_MODEL` is the model mapping
 * measurement 2 made unnecessary, and setting it here would silently override the model a role was assigned:
 * a chain naming `glm-5.3` would be served whatever the mapping said instead, and the run would record the
 * answer against the model it asked for. The timeout is left alone too — horse-code has its own deadlines,
 * and a second, longer one hidden in a settings file would only mask them.
 */
export function zaiSettings(token: string): { env: Record<string, string> } {
  return { env: { ANTHROPIC_BASE_URL: ZAI_BASE_URL, ANTHROPIC_AUTH_TOKEN: token } };
}

/** Where a profile keeps the file Claude Code reads its environment from. */
export function settingsPath(dir: string): string {
  return join(dir, "settings.json");
}

/**
 * Writes the profile, owner-readable only.
 *
 * `0o600` because this file holds a bearer token, and it is the one place in horse-code that ever does. The
 * directory is the account's own, created here, so tightening it takes nothing away from anybody.
 */
export function writeZaiProfile(dir: string, token: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(settingsPath(dir), JSON.stringify(zaiSettings(token), null, 2) + "\n", { mode: 0o600 });
}

/**
 * Whether a directory is a z.ai profile at all — that it names z.ai's endpoint and carries some token.
 *
 * Presence, and it says so: nothing here can tell a live key from a dead one, which is exactly the limit
 * that makes `claude auth status` the wrong question to ask about these profiles. The token's VALUE is never
 * returned; a caller that needs it is doing something this module should not make easy.
 */
export function hasZaiProfile(dir: string): boolean {
  try {
    const raw: unknown = JSON.parse(readFileSync(settingsPath(dir), "utf8"));
    const env = (raw as { env?: Record<string, unknown> })?.env;
    return typeof env?.ANTHROPIC_BASE_URL === "string"
      && env.ANTHROPIC_BASE_URL.includes("z.ai")
      && typeof env.ANTHROPIC_AUTH_TOKEN === "string"
      && env.ANTHROPIC_AUTH_TOKEN.length > 0;
  } catch {
    return false;
  }
}

/**
 * Reads a key the person types, without putting it on their screen.
 *
 * Read from `/dev/tty` rather than from stdin, so it still works when this process's stdin is a pipe, and
 * with the terminal's echo turned off around the read — a key pasted into a visible prompt survives in
 * scrollback, in a screen share, and in whatever recorded the session. It is never passed as an argument
 * either, which would put it in the process table and in shell history.
 *
 * `undefined` when there is no terminal to ask: a non-interactive caller gets a clean refusal instead of a
 * process that blocks forever waiting for a person who is not there.
 */
export function promptSecret(): string | undefined {
  let fd: number;
  try { fd = openSync("/dev/tty", "r"); } catch { return undefined; }
  const hushed = spawnSync("stty", ["-echo"], { stdio: ["inherit", "ignore", "ignore"] }).status === 0;
  try {
    const buf = Buffer.alloc(1);
    let out = "";
    for (;;) {
      let n = 0;
      try { n = readSync(fd, buf, 0, 1, null); } catch { break; }
      if (n === 0) break;
      const ch = buf.toString("utf8");
      if (ch === "\n" || ch === "\r") break;
      out += ch;
    }
    return out.trim() || undefined;
  } finally {
    // Restored even when the read threw: leaving a terminal with echo off makes the shell look broken.
    if (hushed) spawnSync("stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] });
    closeSync(fd);
  }
}

export interface ZaiCheck {
  ok: boolean;
  /** The model that actually answered, as the endpoint named it. The point of asking. */
  served?: string;
  error?: string;
}

/**
 * Asks the endpoint a real question, because it is the only thing that can answer this one.
 *
 * A key that is expired, mistyped, or out of quota is indistinguishable from a good one until something is
 * spent against it — and `claude auth status` will call all four of them connected (measurement 4). One
 * cheap call settles it, and it settles a second thing at the same time: WHICH model served. Claude Code
 * prints `[claude-code:unrecognized_model]` for a GLM id, because the name is not in its own catalog, and
 * that warning is harmless — the request went out with the name intact. What would not be harmless is the
 * `<synthetic>` answer it produces when no model ran at all, so that is checked for by name.
 */
export function verifyZaiProfile(dir: string, model: string, timeoutMs = 120_000): ZaiCheck {
  const r = spawnSync(
    "claude",
    ["--output-format", "stream-json", "--verbose", "--model", model, "-p", "--", "Reply with the single word: ok"],
    { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, encoding: "utf8", timeout: timeoutMs },
  );
  if (r.error) {
    /**
     * A timeout here is the endpoint not answering, not a slow model — the question asked is two words
     * long. Measured against an address with nothing listening: Claude Code retries internally and this
     * waits out the whole budget, then reports `spawnSync claude ETIMEDOUT`, which tells a person nothing
     * about what to check.
     */
    const timedOut = (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return {
      ok: false,
      error: timedOut
        ? `${ZAI_BASE_URL} did not answer within ${Math.round(timeoutMs / 1000)}s`
        : r.error.message,
    };
  }

  let served: string | undefined;
  let text = "";
  let error: string | undefined;
  const reader = makeStreamReader(decodeClaudeEvent, (ev) => {
    if (ev.served) served = ev.served;
    if (ev.text) text += ev.text;
    if (ev.error) error = ev.error;
  });
  reader.push(r.stdout ?? "");
  reader.end();

  if (served === SYNTHETIC) {
    // No model ran: the CLI produced the text itself. Its own answer usually says why.
    return { ok: false, error: text.trim().slice(0, 300) || "the CLI answered without reaching a model" };
  }
  if (error) return { ok: false, error };
  if (r.status !== 0) return { ok: false, error: (r.stderr ?? "").trim().slice(0, 300) || `claude exited ${r.status}` };
  if (!text.trim()) return { ok: false, error: "the endpoint returned an empty answer" };
  return { ok: true, ...(served ? { served } : {}) };
}
