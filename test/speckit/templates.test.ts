import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSpecKit } from "../../src/speckit/templates.js";
import type { FetchLike } from "../../src/providers/omniroute.js";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "hc-sk-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const okFetch = (calls: string[]): FetchLike => async (url) => {
  calls.push(url);
  return new Response(`BODY ${url}`, { status: 200 });
};

describe("loadSpecKit", () => {
  it("fetches every template + command, exposes them, and caches to disk", async () => {
    const calls: string[] = [];
    const sk = await loadSpecKit({ version: "v9.9.9", home, fetch: okFetch(calls) });
    expect(sk.version).toBe("v9.9.9");
    expect(sk.template("spec")).toContain("spec-template.md");
    expect(sk.command("clarify")).toContain("commands/clarify.md");
    expect(calls).toHaveLength(10); // 5 templates + 5 commands
    expect(calls[0]).toBe("https://raw.githubusercontent.com/github/spec-kit/v9.9.9/templates/spec-template.md");
    // cache written
    const cached = await readFile(join(home, ".horsecode/spec-kit/v9.9.9/templates/spec-template.md"), "utf8");
    expect(cached).toContain("spec-template.md");
  });

  it("reads from cache on the second load (no network)", async () => {
    await loadSpecKit({ version: "v9.9.9", home, fetch: okFetch([]) });
    const calls: string[] = [];
    const sk = await loadSpecKit({ version: "v9.9.9", home, fetch: okFetch(calls) });
    expect(calls).toHaveLength(0); // fully cached
    expect(sk.template("plan")).toContain("plan-template.md");
  });

  it("throws an actionable error when a fetch fails and there is no cache", async () => {
    const bad: FetchLike = async () => new Response("nope", { status: 404 });
    await expect(loadSpecKit({ version: "v0.0.0", home, fetch: bad })).rejects.toThrow(/spec-kit template fetch failed \(404\)/);
  });

  it("rejects a path-traversal-shaped version without hitting the network", async () => {
    const throwingFetch: FetchLike = async () => {
      throw new Error("network should not be called for an invalid version");
    };
    await expect(
      loadSpecKit({ version: "../../etc", home, fetch: throwingFetch }),
    ).rejects.toThrow(/not a valid spec-kit release tag/);
  });
});
