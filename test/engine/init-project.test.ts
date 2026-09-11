import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initProject, describeInit, countFiles, UNCLAIMED_FILE_FLOOR,
} from "../../src/engine/init-project.js";
import { localOnly, sharedDerived } from "../../src/engine/trace.js";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "hc-init-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

const run = (untracked: string[] = [], ignored: string[] = []) =>
  initProject(cwd, (p) => ignored.includes(p), () => untracked);

const gitignore = async (): Promise<string> => {
  try { return await readFile(join(cwd, ".gitignore"), "utf8"); } catch { return ""; }
};

/**
 * horse-code leaves two kinds of file in a repository and they are opposites: knowledge that cost tokens to
 * produce and must survive a clone, and derived output rebuilt in minutes from the source. Getting either
 * backwards is silent, and both have happened on real projects.
 */
describe("setting a project up", () => {
  it("keeps the traces out of the ignore rules, so a clone starts with them", async () => {
    await writeFile(join(cwd, ".gitignore"), ".horsecode/\n");
    const report = await run();
    expect(report.changed).toBe(true);
    expect(await gitignore()).toContain("!.horsecode/traces/");
  });

  /**
   * The AST cache, which this rule set's own heading always described and never actually excluded. Measured
   * on a real project: 711 files and 7.8 MB untracked and un-ignored, so `git add -A` after a `/graph build`
   * swept one machine's mtimes into the commit.
   */
  it("excludes the AST cache its own comment always claimed to", async () => {
    expect(localOnly()).toContain("graphify-out/cache/");
    await run();
    expect(await gitignore()).toContain("graphify-out/cache/");
  });

  /** The graph is 29 MB on one line and git merges by line — it is rebuilt, never shared. */
  it("excludes the graph but keeps the names an LLM wrote for it", async () => {
    await run();
    const text = await gitignore();
    expect(text).toContain("graphify-out/graph.json");
    expect(sharedDerived()).toContain("graphify-out/.graphify_labels.json");
    expect(localOnly()).not.toContain("graphify-out/.graphify_labels.json");
  });

  /**
   * Idempotent, and it has to SAY so. The reason to run this twice is usually that horse-code has learned a
   * rule since — the cache rule this command exists because of — so a version that refused to look on the
   * second run would never deliver it.
   */
  it("says nothing changed when the project is already set up", async () => {
    await run();
    const second = await run();
    expect(second.changed).toBe(false);
    expect(describeInit(second)).toContain("already set up");
  });

  it("still applies a rule learned since the first run", async () => {
    // A file that has been through an older version: it carries the marker and the rules of that day.
    await writeFile(join(cwd, ".gitignore"), "# horse-code project knowledge\ngraphify-out/graph.json\n");
    const report = await run();
    expect(report.changed).toBe(true);
    expect(await gitignore()).toContain("graphify-out/cache/");
  });
});

/**
 * What no rule claims. This cannot know whether a directory is build output or somebody's actual work, so it
 * reports and never acts — but it refuses to let weight reach a commit unremarked, which is exactly how 7.8 MB
 * of cache went unnoticed until someone read the diff.
 */
describe("untracked weight no rule covers", () => {
  const many = async (dir: string, n: number): Promise<void> => {
    await mkdir(join(cwd, dir), { recursive: true });
    for (let i = 0; i < n; i++) await writeFile(join(cwd, dir, `f${i}.json`), "{}");
  };

  it("names a big untracked directory nothing has an opinion about", async () => {
    await many("build-out", UNCLAIMED_FILE_FLOOR + 5);
    const report = await run(["build-out/"]);
    expect(report.unclaimed.map((u) => u.path)).toEqual(["build-out/"]);
    expect(describeInit(report)).toContain("`git add -A` would commit these");
  });

  it("says nothing about one the rules already exclude", async () => {
    await many("graphify-out/cache", UNCLAIMED_FILE_FLOOR + 5);
    const report = await run(["graphify-out/"], ["graphify-out/"]);
    expect(report.unclaimed).toEqual([]);
  });

  /** A handful of files is a decision somebody made; hundreds in a directory nobody named is a tool's leavings. */
  it("ignores a small directory", async () => {
    await many("docs", 3);
    expect((await run(["docs/"])).unclaimed).toEqual([]);
  });

  it("says nothing at all when everything is claimed", async () => {
    expect(describeInit(await run())).not.toContain("would commit these");
  });

  /** A cache can hold hundreds of thousands of files; the count stops as soon as the answer is decided. */
  it("stops counting once past the floor", async () => {
    await many("huge", 30);
    expect(countFiles(join(cwd, "huge"), 10)).toBeLessThanOrEqual(10 + 1);
  });
});
