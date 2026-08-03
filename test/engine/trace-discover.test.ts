import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverTraceRoot } from "../../src/engine/trace.js";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "hc-tdisc-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

const put = async (rel: string, body: string): Promise<void> => {
  await mkdir(join(cwd, rel, ".."), { recursive: true });
  await writeFile(join(cwd, rel), body, "utf8");
};

const index = (n = 1): string => JSON.stringify({
  version: 1,
  traces: Object.fromEntries(Array.from({ length: n }, (_, i) => [`src/f${i}.ts`, { hash: "abc", words: 120 }])),
}, null, 2);

/**
 * Where a project keeps its traces is a decision about the PROJECT, but it is recorded in
 * `.horsecode/config.json` — a file that must stay out of git, because it takes the same shape as the user's
 * own config and can carry an api key.
 *
 * So every other checkout of the same repository loses it. Measured: a worktree of a real project reported
 * "no per-file traces" at startup while 2,101 of them sat in `docs/architecture/` beside it, committed. An
 * agent asking `graph_trace` about a file there would have been told there is no trace for it — the cheapest
 * orientation the project has, invisible.
 *
 * The traces already say where they are: their index is committed WITH them. Reading it is better than
 * sharing a config that can hold a secret.
 */
describe("finding the traces a project already has", () => {
  it("finds the root from the index the traces carry", async () => {
    await put("docs/architecture/index.json", index(50));
    expect(discoverTraceRoot(cwd, ["docs/architecture/index.json", "src/a.ts"])).toBe("docs/architecture");
  });

  it("ignores an index.json that is not a trace index", async () => {
    await put("packages/ui/index.json", JSON.stringify({ name: "ui", version: "1.0.0" }));
    await put("data/index.json", JSON.stringify([1, 2, 3]));
    expect(discoverTraceRoot(cwd, ["packages/ui/index.json", "data/index.json"])).toBeUndefined();
  });

  /** An index recording nothing is a root that was set up and never used — it names no location worth using. */
  it("ignores an empty trace index", async () => {
    await put("docs/architecture/index.json", index(0));
    expect(discoverTraceRoot(cwd, ["docs/architecture/index.json"])).toBeUndefined();
  });

  it("prefers the shallowest when a repository somehow has two", async () => {
    await put("deep/nested/place/index.json", index(3));
    await put("docs/index.json", index(3));
    expect(discoverTraceRoot(cwd, ["deep/nested/place/index.json", "docs/index.json"])).toBe("docs");
  });

  it("says nothing when the project has no traces — the default stands", async () => {
    expect(discoverTraceRoot(cwd, ["src/a.ts", "README.md"])).toBeUndefined();
  });

  it("survives a corrupt index rather than failing startup over it", async () => {
    await put("docs/architecture/index.json", "{ not json");
    expect(discoverTraceRoot(cwd, ["docs/architecture/index.json"])).toBeUndefined();
  });

  /** A file git lists but that is not on disk (a stale listing, a sparse checkout) must not throw. */
  it("skips a listed file that is not there", () => {
    expect(discoverTraceRoot(cwd, ["docs/architecture/index.json"])).toBeUndefined();
  });

  /**
   * The listing is every tracked file in the repository — thousands of them, read once at startup. Only the
   * ones that could BE a trace index are opened, and a deeply buried one is not worth the read.
   */
  it("does not open files it has no reason to", async () => {
    await put("a/b/c/d/e/f/index.json", index(3));
    expect(discoverTraceRoot(cwd, ["a/b/c/d/e/f/index.json"])).toBeUndefined();
  });
});
