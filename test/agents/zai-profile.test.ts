import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ZAI_BASE_URL, zaiSettings, settingsPath, writeZaiProfile, hasZaiProfile,
} from "../../src/agents/zai-profile.js";
import { cliBinary, cliArgs, CLI_KINDS } from "../../src/agents/cli-agent.js";
import { profileEnv, statusArgs, runLogin, checkProfile } from "../../src/agents/cli-auth.js";
import { withAmbient } from "../../src/agents/add-provider.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "hc-zai-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/**
 * z.ai ships no CLI. Its own documentation describes the integration the other way round — point Claude Code
 * at an Anthropic-compatible endpoint of theirs — so a z.ai account is a Claude Code PROFILE, and the
 * binary, the argv and the stream are all the ones already built.
 */
describe("z.ai is the Claude binary with another endpoint behind it", () => {
  it("runs claude, because no `zai` program exists anywhere", () => {
    expect(cliBinary("zai")).toBe("claude");
    expect(cliBinary("claude")).toBe("claude");
    expect(cliBinary("codex")).toBe("codex");
    expect(cliBinary("grok")).toBe("grok");
  });

  it("takes Claude Code's argv unchanged", () => {
    expect(cliArgs("zai", "do the thing")).toEqual(cliArgs("claude", "do the thing"));
  });

  /**
   * The same variable, too — what makes the profile a z.ai one is the settings file inside it, not how it is
   * pointed at. Measured: a directory holding only that file sent its request to the address named there.
   */
  it("is pointed at with Claude Code's own variable", () => {
    expect(profileEnv("zai", "/p/z")).toEqual({ CLAUDE_CONFIG_DIR: "/p/z" });
    expect(statusArgs("zai")).toEqual(["auth", "status"]);
  });
});

describe("the profile a z.ai account is", () => {
  it("names z.ai's endpoint and carries the key", () => {
    const s = zaiSettings("k-123");
    expect(s.env.ANTHROPIC_BASE_URL).toBe(ZAI_BASE_URL);
    expect(s.env.ANTHROPIC_AUTH_TOKEN).toBe("k-123");
  });

  /**
   * Deliberately NOT the wider block z.ai's guide suggests. `ANTHROPIC_DEFAULT_*_MODEL` would override the
   * model a role was assigned — a chain naming `glm-5.3` would be served whatever the mapping said, and the
   * run would record that answer against the model it asked for. Measured that it is unnecessary: a
   * `--model` passes into the request body verbatim.
   */
  it("sets nothing that would override the model a role was assigned", () => {
    expect(Object.keys(zaiSettings("k").env).sort()).toEqual(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]);
  });

  /** It holds a bearer token — the one place in horse-code that does — so it is not world-readable. */
  it("writes the key readable only by its owner", () => {
    writeZaiProfile(dir, "k-123");
    expect(statSync(settingsPath(dir)).mode & 0o077).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath(dir), "utf8"))).toEqual(zaiSettings("k-123"));
  });

  it("recognises a written profile, and nothing else", () => {
    expect(hasZaiProfile(dir)).toBe(false);
    writeZaiProfile(dir, "k-123");
    expect(hasZaiProfile(dir)).toBe(true);
  });

  /**
   * A profile carrying the endpoint but no token is not connected — and it is precisely the case
   * `claude auth status` gets right, while getting the bogus-token case wrong.
   */
  it("does not count an endpoint with no key as a profile", () => {
    const d = join(dir, "half"); mkdirSync(d);
    writeFileSync(join(d, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: ZAI_BASE_URL } }));
    expect(hasZaiProfile(d)).toBe(false);
  });

  /** An ordinary Claude profile is not a z.ai one, however it is pointed at. */
  it("does not mistake a Claude profile for a z.ai account", () => {
    const d = join(dir, "cc"); mkdirSync(d);
    writeFileSync(join(d, "settings.json"), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "k" } }));
    expect(hasZaiProfile(d)).toBe(false);
  });
});

/**
 * The trap this integration has to be built around.
 *
 * A z.ai account is a Claude Code profile pointed elsewhere, so asking "what would a call with NO profile
 * do" is answered by Claude Code's own session — the person's Anthropic account, reported with their real
 * address. Recorded as a z.ai default, the pool would hand z.ai's turn to an Anthropic subscription and file
 * the spend against it.
 */
describe("z.ai has no ambient login to inherit", () => {
  const anthropic = { loggedIn: true, email: "someone@example.com", plan: "max" };

  it("never adopts the signed-in Claude session as a z.ai account", () => {
    expect(withAmbient("zai", [], anthropic)).toEqual([]);
  });

  /** The behaviour it must not disturb: for the CLIs that DO have one, the default is still recorded. */
  it("still adopts it for Claude itself", () => {
    expect(withAmbient("claude", [], anthropic)).toHaveLength(1);
  });

  /**
   * And there is no sign-in to run either. Claude Code's would open ANTHROPIC's OAuth and write an Anthropic
   * session into a directory meant to hold a z.ai key — so it is refused rather than attempted.
   */
  it("refuses a sign-in that would authenticate the wrong company", () => {
    const r = runLogin("zai", "/tmp/never-used");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no sign-in/i);
  });

  /**
   * Asked ambiently, the status check would run plain `claude auth status` and answer with the person's own
   * Anthropic session. Observed while wiring this up: a probe asking every kind reported the Anthropic
   * subscription, address and plan, under z.ai's name. It answers "not connected" instead — without
   * spawning anything, so the wrong answer is not merely filtered out downstream but never produced.
   */
  it("reports no ambient z.ai session rather than the Anthropic one behind it", () => {
    expect(checkProfile("zai")).toEqual({ loggedIn: false });
  });
});

/** Every kind must be answerable by these, or a new one silently inherits another's behaviour. */
describe("every subscription is accounted for", () => {
  it("has a binary and an argv", () => {
    for (const kind of CLI_KINDS) {
      expect(cliBinary(kind), kind).toBeTruthy();
      expect(cliArgs(kind, "x").some((a) => a.includes("x")), kind).toBe(true);
    }
  });
});
