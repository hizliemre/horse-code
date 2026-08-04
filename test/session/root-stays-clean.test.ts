import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/session/memory.js";
import { writableStateRoot } from "../../src/engine/session-scope.js";

let dir: string;
let project: string;
let base: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-root-"));
  project = join(dir, "proj");
  base = join(project, ".horsecode", "worktrees", "job", "base");
  await mkdir(base, { recursive: true });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const rootFile = (): string => join(project, ".horsecode", "memory.jsonl");
const sessionFile = (): string => join(base, ".horsecode", "memory.jsonl");

/**
 * A run must leave the project checkout exactly as it found it.
 *
 * Measured on a real checkout after a job: `.horsecode/memory.jsonl`, `graphify-out/graph.json`,
 * `graphify-out/.graphify_labels.json` and `docs/architecture/index.json` all modified and uncommitted —
 * four files that both sides of a merge regenerate. When the pull request was merged, `git pull` into that
 * checkout refused to apply: 80 commits behind, 8 dirty files in the way, and half of them ours.
 *
 * The rule already existed in the code, on `isSessionBase`: "the one place a run may write project state".
 * It had no callers.
 */
describe("where a run may write", () => {
  it("says nothing is writable outside a session", () => {
    expect(writableStateRoot(project)).toBeUndefined();
  });

  it("resolves to the session base from anywhere inside it", () => {
    expect(writableStateRoot(base)).toBe(base);
    expect(writableStateRoot(join(base, "src", "deep"))).toBe(base);
  });
});

/**
 * Refining, sizing and triage all run before the worktree exists, and all can learn something. Writing it at
 * the root is the leak; dropping it would lose what those phases paid for. So it waits.
 */
describe("what a job learns before its session exists", () => {
  it("does not reach the project checkout", async () => {
    const store = new MemoryStore({ home: dir, cwd: project });
    store.deferUntilSession();
    await store.add("the refiner learned this", "fact");
    expect(existsSync(rootFile()), "the run wrote into the project checkout").toBe(false);
  });

  it("lands in the session the moment one opens", async () => {
    const store = new MemoryStore({ home: dir, cwd: project });
    store.deferUntilSession();
    await store.add("the refiner learned this", "fact");
    store.retarget(base);
    const entries = await store.load();
    expect(entries.map((e) => e.text)).toContain("the refiner learned this");
    expect(await readFile(sessionFile(), "utf8")).toContain("the refiner learned this");
    expect(existsSync(rootFile())).toBe(false);
  });

  it("keeps what the session already carried, and adds to it", async () => {
    await mkdir(join(base, ".horsecode"), { recursive: true });
    await writeFile(sessionFile(),
      JSON.stringify({ id: "m1", text: "inherited from the project", kind: "fact" }) + "\n", "utf8");
    const store = new MemoryStore({ home: dir, cwd: project });
    store.deferUntilSession();
    await store.add("learned while sizing", "fact");
    store.retarget(base);
    const texts = (await store.load()).map((e) => e.text);
    expect(texts).toContain("inherited from the project");
    expect(texts).toContain("learned while sizing");
  });

  /** …and only once: a second read must not append it again. */
  it("releases the held entries exactly once", async () => {
    const store = new MemoryStore({ home: dir, cwd: project });
    store.deferUntilSession();
    await store.add("said once", "fact");
    store.retarget(base);
    await store.load();
    const again = await new MemoryStore({ home: dir, cwd: base }).load();
    expect(again.filter((e) => e.text === "said once").length).toBe(1);
  });
});

/**
 * A person typing `/remember` is writing to the project ON PURPOSE, and that is the feature. The rule is
 * about what a run does as a side effect — not about what someone asked for.
 */
describe("what a person asks to be remembered", () => {
  it("still reaches the project, because that is what was asked", async () => {
    const store = new MemoryStore({ home: dir, cwd: project });
    await store.add("prefer pnpm", "fact");
    expect(await readFile(rootFile(), "utf8")).toContain("prefer pnpm");
  });
});

/**
 * The second half of the leak: the graph was rebuilt in the project checkout after every finished job.
 *
 * `refreshGraphIfStale` called `buildProjectGraph(process.cwd())` — the root — from the line right after
 * `endRun`. Measured on a real checkout: `graphify-out/graph.json` and `.graphify_labels.json` left modified
 * and uncommitted, the labels file grown to 6,334 entries of which 2,896 were bare `Community <n>`
 * placeholders. A rebuild had found new communities and nothing had named them.
 *
 * The graph that ships is refreshed inside the session by the trace pass. Rebuilding the root's is a
 * deliberate act — `/graph` — not something a finished job decides on the user's behalf.
 */
describe("the graph the project checkout holds", () => {
  it("is brought up to date at startup, not after a job", async () => {
    const { readFile: rf } = await import("node:fs/promises");
    const src = await rf("src/tui/app.tsx", "utf8");
    const afterRun = src.slice(src.indexOf("controller.endRun("), src.indexOf("controller.endRun(") + 300);
    expect(afterRun).not.toContain("refreshGraphIfStale");
    // …and the startup path is where it happens, once, before anything asks the graph a question.
    const startup = src.slice(src.indexOf("startupExtra.graph ="), src.indexOf("startupExtra.graph =") + 500);
    expect(startup).toContain("refreshGraphIfStale()");
  });

  /**
   * Rebuilding the checkout's graph is only safe because it is no longer committed.
   *
   * It used to be shared, so every rebuild left the checkout modified and the next merge tripped over it —
   * on PR 677 that was the whole conflict. Now the graph is local per checkout and a build drops the
   * `Community <n>` placeholders instead of adding them to the shared names file.
   */
  it("is rebuildable without leaving anything for git to see", async () => {
    const { localOnly, sharedDerived } = await import("../../src/engine/trace.js");
    expect(localOnly()).toContain("graphify-out/graph.json");
    expect(sharedDerived()).not.toContain("graphify-out/graph.json");
  });

  it("is still rebuildable on request", async () => {
    const { readFile: rf } = await import("node:fs/promises");
    expect(await rf("src/cli.ts", "utf8")).toContain("buildProjectGraph(cwd)");
  });
});
