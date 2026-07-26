import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  externalSkillsDir, validName, installedSource, cachedSkillNames, syncSkillSources, installSkillSource,
} from "../../src/skills/external.js";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "hc-ext-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const seed = async (name: string, sha = "abc123"): Promise<void> => {
  const dir = join(externalSkillsDir(home), name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody`, "utf8");
  await writeFile(join(dir, ".horsecode-source.json"),
    JSON.stringify({ name, repo: "o/r", sha, installedAt: 1 }), "utf8");
};

describe("external skills live outside this repo", () => {
  // The whole point: the skill is a REFERENCE to upstream, not a copy frozen at the moment it was taken.
  it("caches under the user's home, never in the project", () => {
    expect(externalSkillsDir("/h")).toBe(join("/h", ".horsecode", "skills"));
  });

  // The name becomes a directory, so it must not be able to escape one.
  it.each(["../evil", "a/b", "..", "with space", ""])("rejects the unsafe name %o", (n) => {
    expect(validName(n)).toBe(false);
  });
  it.each(["impeccable", "ui-ux", "design_system", "v1.2"])("accepts %s", (n) => {
    expect(validName(n)).toBe(true);
  });

  it("records what commit is installed, so an update can tell whether anything changed", async () => {
    await seed("impeccable", "deadbeef");
    expect((await installedSource(home, "impeccable"))?.sha).toBe("deadbeef");
  });

  it("reports nothing for a skill that was never installed", async () => {
    expect(await installedSource(home, "nope")).toBeUndefined();
  });

  it("lists what is on disk", async () => {
    await seed("one"); await seed("two");
    expect((await cachedSkillNames(home)).sort()).toEqual(["one", "two"]);
  });

  it("an empty cache is not an error", async () => {
    expect(await cachedSkillNames(home)).toEqual([]);
  });
});

describe("installSkillSource — refusals happen before anything is downloaded", () => {
  const noNetwork = { fetch: (async () => { throw new Error("network must not be touched"); }) as unknown as typeof fetch };

  it("refuses a name that would escape the cache directory", async () => {
    await expect(installSkillSource(home, { name: "../evil", repo: "o/r" }, noNetwork))
      .rejects.toThrow(/not a valid directory name/);
  });

  it("refuses a malformed repo", async () => {
    await expect(installSkillSource(home, { name: "x", repo: "not-a-repo" }, noNetwork))
      .rejects.toThrow(/owner\/repo/);
  });

  it("refuses a traversing subpath", async () => {
    await expect(installSkillSource(home, { name: "x", repo: "o/r", path: "../../etc" }, noNetwork))
      .rejects.toThrow(/may not contain/);
  });

  it("skips the download entirely when the installed commit already matches", async () => {
    await seed("impeccable", "cafe1234");
    const r = await installSkillSource(home, { name: "impeccable", repo: "o/r" }, {
      fetch: (async () => new Response("cafe1234")) as unknown as typeof fetch,
    });
    expect(r).toEqual({ name: "impeccable", sha: "cafe1234", changed: false });
  });

  it("surfaces an unresolvable ref rather than guessing", async () => {
    await expect(installSkillSource(home, { name: "x", repo: "o/r", ref: "nope" }, {
      fetch: (async () => new Response("", { status: 404 })) as unknown as typeof fetch,
    })).rejects.toThrow(/cannot resolve/);
  });
});

describe("syncSkillSources", () => {
  // One broken source must not stop the others from updating.
  it("isolates failures per source", async () => {
    await seed("good", "aaa");
    const { ok, failed } = await syncSkillSources(home, [
      { name: "good", repo: "o/r" },
      { name: "../bad", repo: "o/r" },
    ], { fetch: (async () => new Response("aaa")) as unknown as typeof fetch });
    expect(ok.map((r) => r.name)).toEqual(["good"]);
    expect(failed.map((f) => f.name)).toEqual(["../bad"]);
  });

  it("nothing configured is not an error", async () => {
    expect(await syncSkillSources(home, [])).toEqual({ ok: [], failed: [] });
  });
});
