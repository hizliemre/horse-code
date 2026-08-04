import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { graphStatus, changedSince, readStamp, stampPath, GRAPH_DIR } from "../../src/engine/project-graph.js";
import { sharedDerived } from "../../src/engine/trace.js";

let cwd: string;
const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "hc-fresh-"));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(cwd, GRAPH_DIR), { recursive: true });
  await writeFile(join(cwd, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await writeFile(join(cwd, GRAPH_DIR, "graph.json"),
    JSON.stringify({ nodes: [{ label: "a", source_file: "src/a.ts" }], edges: [] }), "utf8");
  git("add", "-A");
  git("commit", "-qm", "one");
});
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

const stamp = async (): Promise<void> => {
  await writeFile(stampPath(cwd), JSON.stringify({ commit: git("rev-parse", "HEAD").trim() }), "utf8");
};

/** Makes every file look written AFTER the graph, which is what git does on a checkout. */
const touchAllAfterGraph = async (): Promise<void> => {
  const later = new Date(Date.now() + 5_000);
  await utimes(join(cwd, "src", "a.ts"), later, later);
};

/**
 * A file's mtime is when git last WROTE it, not when the graph was built.
 *
 * Measured on a real checkout after a routine `git pull` that brought the graph itself: git wrote
 * `graphify-out/graph.json` and then, 9 to 14 milliseconds later, the `toucan/…` files that sort after it —
 * so the graph that had just arrived was reported out of date. Every pull, checkout and branch switch did
 * this, and each false alarm asked for a rebuild of 47,000 nodes.
 */
describe("whether the graph is out of date", () => {
  it("is not decided by timestamps when the graph says which commit it describes", async () => {
    await stamp();
    await touchAllAfterGraph();          // …exactly what a pull leaves behind
    const st = await graphStatus(cwd);
    expect(st.built).toBe(true);
    expect(st.stale, `reported stale because of ${st.staleBecause.join(", ")}`).toBe(false);
  });

  it("is stale when a file the graph knows has actually changed since", async () => {
    await stamp();
    await writeFile(join(cwd, "src", "a.ts"), "export const a = 2;\n", "utf8");
    const st = await graphStatus(cwd);
    expect(st.stale).toBe(true);
    expect(st.staleBecause).toContain("src/a.ts");
  });

  it("is stale when a new source file appears, committed or not", async () => {
    await stamp();
    await writeFile(join(cwd, "src", "b.ts"), "export const b = 1;\n", "utf8");
    const st = await graphStatus(cwd);
    expect(st.stale).toBe(true);
    expect(st.staleBecause).toContain("src/b.ts");
  });

  it("counts a commit made since the stamp", async () => {
    await stamp();
    await writeFile(join(cwd, "src", "c.ts"), "export const c = 1;\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "two");
    expect((await graphStatus(cwd)).staleBecause).toContain("src/c.ts");
  });

  /** Changes that are not code the graph would carry are not a reason to rebuild it. */
  it("ignores what graphify never indexes", async () => {
    await stamp();
    await writeFile(join(cwd, "README.md"), "# hello\n", "utf8");
    expect((await graphStatus(cwd)).stale).toBe(false);
  });

  /** A graph built before stamps existed still works — on the older, weaker check. */
  it("falls back to timestamps when there is no stamp", async () => {
    await touchAllAfterGraph();
    expect((await graphStatus(cwd)).stale).toBe(true);
  });

  it("falls back when the stamp names a commit this checkout does not have", async () => {
    await writeFile(stampPath(cwd), JSON.stringify({ commit: "0".repeat(40) }), "utf8");
    expect(await changedSince(cwd, "0".repeat(40))).toBeUndefined();
  });
});

describe("the stamp itself", () => {
  it("is read back when it is well-formed, and ignored when it is not", async () => {
    await stamp();
    expect((await readStamp(cwd))?.commit).toBe(git("rev-parse", "HEAD").trim());
    await writeFile(stampPath(cwd), "not json", "utf8");
    expect(await readStamp(cwd)).toBeUndefined();
  });

  /** It ships with the graph: a clone without it falls back to timestamps, which is the bug. */
  it("is shared, like the graph it describes", () => {
    expect(sharedDerived()).toContain("graphify-out/.graph-commit.json");
  });
});
