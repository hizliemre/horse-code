import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
 *      a real call and never by that answer — see `verifyZaiKey`.
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

export interface ZaiCheck {
  ok: boolean;
  /** The model that actually answered, as the endpoint named it. The point of asking. */
  served?: string;
  /** What went wrong, in the endpoint's OWN words wherever it supplied any. */
  error?: string;
}

/**
 * Asks the endpoint a real question, directly, and hands back whatever it says.
 *
 * The first version of this asked THROUGH Claude Code, and a live key proved that wrong twice over. What a
 * verification needs is one round trip; what it got was a whole agent session — the project's CLAUDE.md,
 * hooks and skills loaded into a system prompt, a trust dialog for a config directory that had never seen
 * the workspace, a `generate_session_title` side call to the same endpoint, and Claude Code's own retry
 * policy on top. Measured against a real z.ai key: no answer in 90 seconds from an EMPTY directory with
 * stdin closed, so none of that context was even the cause.
 *
 * And the cause was a sentence the endpoint had said immediately, which all of that machinery swallowed:
 *
 *   HTTP 429  {"type":"error","error":{"type":"rate_limit_error","code":"1113",
 *              "message":"[1113][Insufficient balance or no resource package. Please recharge.]"}}
 *
 * A person told "Insufficient balance" goes and looks at their plan. A person told "did not answer within
 * 120s" has no idea whether to blame the key, the network, the model name or this program. One HTTPS request
 * gets the first answer in under a second, so that is what this does.
 *
 * The key is checked BEFORE the profile is written, which is why this takes a token rather than a directory:
 * a key the endpoint refuses should leave nothing on disk at all.
 */
export async function verifyZaiKey(token: string, model: string, timeoutMs = 30_000): Promise<ZaiCheck> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${ZAI_BASE_URL}/v1/messages`, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "content-type": "application/json",
        // Both spellings: z.ai accepts the bearer form, and `x-api-key` is what the Anthropic wire format
        // names. Sending each costs nothing and removes a guess about which one this endpoint reads.
        authorization: `Bearer ${token}`,
        "x-api-key": token,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "Reply with: ok" }] }),
    });
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) return { ok: false, error: zaiErrorText(body) ?? `the endpoint answered HTTP ${res.status}` };
    const served = (body as { model?: string } | undefined)?.model;
    return { ok: true, ...(served ? { served } : {}) };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      error: aborted
        ? `${ZAI_BASE_URL} did not answer within ${Math.round(timeoutMs / 1000)}s`
        : e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The endpoint's own account of a refusal.
 *
 * z.ai answers in the Anthropic error shape, and the sentence inside is the whole value of asking — "[1113]
 * [Insufficient balance or no resource package. Please recharge.]" names a thing a person can go and fix.
 * Anything unrecognisable returns undefined so the caller falls back to the status code rather than
 * inventing a diagnosis.
 */
export function zaiErrorText(body: unknown): string | undefined {
  const msg = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
  return typeof msg === "string" && msg.trim() ? msg.trim() : undefined;
}
