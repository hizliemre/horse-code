import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  pruneAreaNames, namedCount, LABEL_LOSS_LIMIT,
} from "../../src/engine/project-graph.js";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "hc-labels-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

const seed = async (nodes: unknown[], labels?: Record<string, string>): Promise<void> => {
  await mkdir(join(cwd, "graphify-out"), { recursive: true });
  await writeFile(join(cwd, "graphify-out", "graph.json"), JSON.stringify({ nodes, links: [] }), "utf8");
  if (labels) {
    await writeFile(join(cwd, "graphify-out", ".graphify_labels.json"), JSON.stringify(labels, null, 2), "utf8");
  }
};

const read = async (): Promise<Record<string, string>> =>
  JSON.parse(await readFile(join(cwd, "graphify-out", ".graphify_labels.json"), "utf8")) as Record<string, string>;

/**
 * Every rebuild re-partitions the graph, so the community a name was written FOR may not exist afterwards —
 * the name survives, pointing at a number nothing carries any more. Measured on a real project: 6283 recorded
 * names, 2822 of them (44%) unreachable, in a file that is committed and read by people.
 */
describe("names for communities that no longer exist", () => {
  it("drops the entries the graph cannot resolve, and keeps the rest", async () => {
    await seed(
      [{ id: "a", label: "a", community: 0 }, { id: "b", label: "b", community: 1 }],
      { "0": "Billing", "1": "Checkout", "7": "Community 7", "9": "Old Area That Was Re-Partitioned" },
    );
    expect(await pruneAreaNames(cwd)).toBe(2);
    expect(await read()).toEqual({ "0": "Billing", "1": "Checkout" });
  });

  /**
   * The hazard that makes this worth a test of its own: a rebuild that fails, or one interrupted before it
   * writes communities, leaves a graph with none. Pruning against THAT would delete every name in the file —
   * an LLM pass over thousands of communities, gone because a build did not finish.
   */
  it("does nothing when the graph carries no communities at all", async () => {
    await seed([{ id: "a", label: "a" }, { id: "b", label: "b" }], { "0": "Billing", "1": "Checkout" });
    expect(await pruneAreaNames(cwd)).toBe(0);
    expect(await read()).toEqual({ "0": "Billing", "1": "Checkout" });
  });

  it("does nothing when the graph is empty or unreadable", async () => {
    await seed([], { "0": "Billing" });
    expect(await pruneAreaNames(cwd)).toBe(0);
    expect(await read()).toEqual({ "0": "Billing" });

    await writeFile(join(cwd, "graphify-out", "graph.json"), "{ not json", "utf8");
    expect(await pruneAreaNames(cwd)).toBe(0);
    expect(await read()).toEqual({ "0": "Billing" });
  });

  it("writes nothing when every name still resolves", async () => {
    await seed([{ id: "a", label: "a", community: 0 }], { "0": "Billing" });
    const before = await readFile(join(cwd, "graphify-out", ".graphify_labels.json"), "utf8");
    expect(await pruneAreaNames(cwd)).toBe(0);
    expect(await readFile(join(cwd, "graphify-out", ".graphify_labels.json"), "utf8")).toBe(before);
  });

  it("is a no-op for a project that has no names", async () => {
    await seed([{ id: "a", label: "a", community: 0 }]);
    expect(await pruneAreaNames(cwd)).toBe(0);
    expect(existsSync(join(cwd, "graphify-out", ".graphify_labels.json"))).toBe(false);
  });

  /** Quiet pruning of a committed file is how an unexplained diff turns up in someone's pull request. */
  it("says what it dropped, rather than dropping it silently", async () => {
    const { describeRefresh } = await import("../../src/engine/trace-refresh.js");
    const line = describeRefresh({ traced: 0, failed: 0, removed: 0, skipped: 0, staleNames: 2822 });
    expect(line).toContain("2822");
    expect(line).toMatch(/pointing at nothing/);
    // …and a refresh that changed nothing at all still says nothing.
    expect(describeRefresh({ traced: 0, failed: 0, removed: 0, skipped: 3 })).toBeUndefined();
  });

  /**
   * The file is committed and read by people, and it is rewritten by this function on every refresh. One key
   * per line, in numeric order, is what makes git store a change to one name as a change to one line.
   */
  it("keeps the shape that lets git store a one-name change as a one-line change", async () => {
    await seed(
      [{ id: "a", label: "a", community: 2 }, { id: "b", label: "b", community: 10 }],
      { "10": "Ten", "2": "Two", "5": "Gone" },
    );
    await pruneAreaNames(cwd);
    const text = await readFile(join(cwd, "graphify-out", ".graphify_labels.json"), "utf8");
    expect(text.trimEnd().split("\n").length).toBe(4);        // { , two entries, }
    expect(text.indexOf('"2"')).toBeLessThan(text.indexOf('"10"')); // numeric order, not "10" before "2"
  });
});

/**
 * …and what a rebuild does to those names, when the rebuild does not finish.
 *
 * Reported live: a session was stopped while the start-up rebuild was running, and the project checkout was
 * left with `.graphify_labels.json` modified — 3,183 placeholder entries where the committed file had 396,
 * and 182 real names gone. The restore existed; it was the LAST statement of the build, so being interrupted
 * skipped it. A cleanup that only runs when nothing goes wrong protects nothing.
 */
describe("what counts as a name", () => {
  it("does not count the placeholders graphify seeds", () => {
    expect(namedCount({ "1": "Community 1", "2": "Wallet Member & Balance", "3": "community_3", "4": "Sync Log" }))
      .toBe(2);
  });

  /**
   * The gate is for a build that FINISHES and still forgot. The interrupted one is caught by the restore —
   * it lost 6% of the names, well inside the limit, so a threshold would never have saved it.
   */
  it("measures loss against what is committed, not against the placeholders", () => {
    const before = namedCount(Object.fromEntries(Array.from({ length: 3139 }, (_, i) => [i, `Name ${i}`])));
    const after = namedCount({
      ...Object.fromEntries(Array.from({ length: 2957 }, (_, i) => [i, `Name ${i}`])),
      ...Object.fromEntries(Array.from({ length: 3183 }, (_, i) => [3000 + i, `Community ${3000 + i}`])),
    });
    expect([before, after]).toEqual([3139, 2957]);
    expect(after < before * (1 - LABEL_LOSS_LIMIT)).toBe(false);
    expect(namedCount({ "1": "Only" }) < before * (1 - LABEL_LOSS_LIMIT)).toBe(true);
  });
});

/**
 * The restore has to survive the build not finishing, which means it cannot be a step OF the build.
 *
 * Asserted on the source: a real build needs graphify installed and a repository to parse, and what is being
 * checked here is the control flow — that the restore runs on entry and from `finally`.
 */
describe("when the shared names file is put back", () => {
  it("runs on the way in and on every way out", async () => {
    const src = await readFile("src/engine/project-graph.ts", "utf8");
    const fn = src.slice(src.indexOf("export async function buildProjectGraph"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("if (shared) await restoreSharedLabels(cwd);");
    expect(body).toContain("} finally {");
  });

  it("restores the tracked file, not a guessed path", async () => {
    const src = await readFile("src/engine/project-graph.ts", "utf8");
    expect(src).toContain('["checkout", "--", `${GRAPH_DIR}/${LABELS_FILE}`]');
  });

  /** The mechanism itself: git has the committed version, whatever the working tree was left holding. */
  it("git can undo what an interrupted build wrote", async () => {
    const git = (...a: string[]): string =>
      execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const rel = join("graphify-out", ".graphify_labels.json");
    await seed([{ id: "a", label: "a", community: 0 }], { "0": "Wallet Member & Balance", "1": "Sync Log" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    git("add", "-A");
    git("commit", "-q", "-m", "labels");

    await writeFile(join(cwd, rel), JSON.stringify({ "0": "Community 0", "1": "Community 1", "2": "Community 2" }), "utf8");
    expect(namedCount(await read())).toBe(0);

    git("checkout", "--", rel);
    expect(namedCount(await read())).toBe(2);
    expect(git("status", "--porcelain").trim()).toBe("");
  });
});
