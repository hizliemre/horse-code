import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, USAGE_FILE } from "../../src/session/memory.js";

let home: string;
let t = 0;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "hc-mem-")); t = 0; });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const store = (cwd = join(home, "proj-a")): MemoryStore => new MemoryStore({ home, cwd, now: () => ++t });

describe("MemoryStore", () => {
  it("adds a fact with derived anchors/tags and persists across instances", async () => {
    const s = store();
    const res = await s.add("prefer pnpm in src/app.ts");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.entry.anchors).toContain("src/app.ts");
      expect(res.entry.tags).toContain("pnpm");
    }
    const reopened = store();
    const loaded = await reopened.load();
    expect(loaded.map((e) => e.text)).toEqual(["prefer pnpm in src/app.ts"]);
  });

  it("counts an injection twice: once as raw exposure, once as a fair sample", async () => {
    // `observedInjections` is the honest denominator — it starts only once every consumer reports usage, so
    // a memory carried over from the blind era is not judged on injections nobody could credit.
    const s = store();
    const res = await s.add("prefer pnpm in src/app.ts");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await s.recordInjection([res.entry.id]);
    await s.recordInjection([res.entry.id]);
    const [e] = await store().load();
    expect(e!.injections).toBe(2);
    expect(e!.observedInjections).toBe(2);
  });

  it("rejects an empty memory", async () => {
    expect(await store().add("   ")).toEqual({ ok: false, error: "empty memory" });
  });

  it("dedupes identical facts (so auto-remember doesn't pile up)", async () => {
    const s = store();
    expect((await s.add("use pnpm")).ok).toBe(true);
    expect(await s.add("use pnpm")).toEqual({ ok: false, error: "already remembered" });
    expect(s.all()).toHaveLength(1);
  });

  it("a superseding fact replaces the stale same-topic one (reported in `superseded`)", async () => {
    const s = store();
    await s.add("the api base url is https://old.example.com");
    const r = await s.add("the api base url is https://new.example.com");
    expect(r.ok && r.superseded).toContain("the api base url is https://old.example.com");
    expect(s.all().map((e) => e.text)).toEqual(["the api base url is https://new.example.com"]);
  });

  it("serializes concurrent writes without losing entries (parallel-writer safety)", async () => {
    // distinct-topic facts (no supersession between them) to isolate the concurrency behavior
    const facts = [
      "prefer pnpm over npm", "the api base is example.com", "tests live in spec dir",
      "deploy runs on push", "logging uses pino library", "auth handled by clerk",
      "database is postgres", "styling with tailwind", "bundler is tsup", "runtime targets node",
    ];
    const s = store();
    await Promise.all(facts.map((f) => s.add(f)));
    expect(s.all()).toHaveLength(10);
    const reopened = store();
    expect(await reopened.load()).toHaveLength(10); // all 10 survived on disk
  });

  it("stores a lesson with kind 'lesson'; a lesson supersedes a same-topic lesson", async () => {
    const s = store();
    await s.add("the api base is old.com", "lesson");
    const r = await s.add("the api base is new.com", "lesson");
    expect(r.ok && r.superseded).toContain("the api base is old.com");
    expect(s.all()).toHaveLength(1);
    expect(s.all()[0].kind).toBe("lesson");
  });

  it("stores a rule with kind 'rule'; a rule supersedes a same-topic rule but not a fact", async () => {
    const s = store();
    await s.add("always answer in English", "rule");
    const r = await s.add("always answer in Turkish", "rule");
    expect(r.ok && r.superseded).toContain("always answer in English");
    expect(s.all()).toHaveLength(1);
    expect(s.all()[0].kind).toBe("rule");
    const r2 = await s.add("the api base is https://x.example.com", "fact"); // different topic/kind → coexists
    expect(r2.ok).toBe(true);
    expect(s.all()).toHaveLength(2);
  });

  it("a fact does not supersede a same-topic lesson (different kinds coexist)", async () => {
    const s = store();
    await s.add("the api base is old.com", "lesson");
    const r = await s.add("the api base is new.com", "fact"); // same topic, different kind
    expect(r.ok && r.superseded).toEqual([]); // the lesson is not replaced by a fact
    expect(s.all()).toHaveLength(2);
  });

  it("reinforce bumps a memory's use count and persists it", async () => {
    const s = store();
    const r = await s.add("prefer pnpm");
    const id = r.ok ? r.entry.id : "";
    await s.reinforce(id);
    await s.reinforce(id);
    expect(s.all().find((e) => e.id === id)?.uses).toBe(2);
    const reopened = store();
    expect((await reopened.load()).find((e) => e.id === id)?.uses).toBe(2);
  });

  it("scopes memory per project", async () => {
    await store(join(home, "a")).add("only in a");
    expect(await store(join(home, "b")).load()).toEqual([]);
  });

  it("forgets the N-th memory (1-based); out of range → undefined", async () => {
    const s = store();
    await s.add("one"); await s.add("two"); await s.add("three");
    expect(await s.remove(2)).toBe("two");
    expect(s.all().map((e) => e.text)).toEqual(["one", "three"]);
    expect(await s.remove(9)).toBeUndefined();
  });
});

describe("anchored memories are re-verified against the code", () => {
  it("fingerprints file anchors on write and flags the memory stale once that file changes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hc-mem-anchor-"));
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      const file = join(cwd, "src", "auth.ts");
      await writeFile(file, "export const validate = 1;", "utf8");
      const s = new MemoryStore({ home: cwd, cwd });
      await s.load();
      const r = await s.add("token validation lives in src/auth.ts");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.entry.anchorHashes?.["src/auth.ts"]).toBeTruthy(); // fingerprinted at write time

      s.verify(true);
      expect(s.stale()).toEqual([]); // unchanged → still trustworthy

      await writeFile(file, "export const validate = 2; // rewritten", "utf8");
      s.verify(true);
      expect(s.stale().map((e) => e.text)).toEqual(["token validation lives in src/auth.ts"]);
      expect(s.all().find((e) => e.stale)).toBeTruthy();
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("a memory with no file anchor is never flagged stale", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hc-mem-anchor-"));
    try {
      const s = new MemoryStore({ home: cwd, cwd });
      await s.load();
      await s.add("always answer in Turkish", "rule");
      s.verify(true);
      expect(s.stale()).toEqual([]);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});

describe("persistence classes + audience at write time", () => {
  it("rules are permanent by default; short-lived entries get a TTL and are pruned", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hc-mem-ttl-"));
    try {
      let t = 1_000_000;
      const s = new MemoryStore({ home: cwd, cwd, now: () => t });
      await s.load();
      const rule = await s.add("always answer in Turkish", "rule");
      expect(rule.ok && rule.entry.persistence).toBe("permanent");
      expect(rule.ok && rule.entry.expiresAt).toBeUndefined();

      const scratch = await s.add("the sandbox port is 4310", "fact", { persistence: "short" });
      expect(scratch.ok && scratch.entry.persistence).toBe("short");
      expect(scratch.ok && scratch.entry.expiresAt).toBeGreaterThan(t);

      expect(await s.pruneExpired()).toBe(0); // nothing due yet
      t += 25 * 60 * 60 * 1000;               // a day later
      expect(await s.pruneExpired()).toBe(1); // the short-lived note is gone
      expect(s.all().map((e) => e.text)).toEqual(["always answer in Turkish"]); // the rule survives
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("records who learned a memory and who it is addressed to", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "hc-mem-aud-"));
    try {
      const s = new MemoryStore({ home: cwd, cwd });
      await s.load();
      const r = await s.add("diffs need a migration note", "lesson", { learnedBy: "code-reviewer", audience: ["code-reviewer", "coder"] });
      expect(r.ok && r.entry.learnedBy).toBe("code-reviewer");
      expect(r.ok && r.entry.audience).toEqual(["code-reviewer", "coder"]);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});

/**
 * The id used to be the millisecond clock alone, which is unique only while writes are seconds apart. A
 * migration importing 1878 facts in one loop put several into the same millisecond: measured on the real
 * file, 1471 entries carried 1344 distinct ids — 101 ids shared by up to five entries each.
 *
 * Every consumer resolves an id with `find`, which returns the FIRST match, so a use is credited to the
 * wrong memory, an injection is counted against the wrong row, and `/forget` deletes something the user was
 * not looking at.
 */
describe("memory ids are unique", () => {
  it("does not repeat an id when many entries are written in the same millisecond", async () => {
    const s = new MemoryStore({ home, cwd: join(home, "proj"), now: () => 1000 }); // a clock that never moves
    for (let i = 0; i < 25; i++) await s.add(`fact number ${i}`);
    const ids = (await s.load()).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("repairs a file that was already written with colliding ids", async () => {
    const dir = join(home, "proj-dup", ".horsecode");
    await mkdir(dir, { recursive: true });
    const row = (text: string) =>
      JSON.stringify({ id: "m1", text, anchors: [], tags: [], createdAt: 1, kind: "fact" });
    await writeFile(join(dir, "memory.jsonl"), [row("a"), row("b"), row("c")].join("\n") + "\n", "utf8");

    const loaded = await new MemoryStore({ home, cwd: join(home, "proj-dup") }).load();
    expect(loaded.map((e) => e.id)).toEqual(["m1", "m1-2", "m1-3"]);
    expect(loaded.map((e) => e.text)).toEqual(["a", "b", "c"]); // the rows themselves are untouched

    // …and the repair is on disk, so the next process does not have to redo it.
    const again = await new MemoryStore({ home, cwd: join(home, "proj-dup") }).load();
    expect(again.map((e) => e.id)).toEqual(["m1", "m1-2", "m1-3"]);
  });

  it("leaves a healthy file alone", async () => {
    const s = new MemoryStore({ home, cwd: join(home, "proj-ok") });
    await s.add("one thing");
    const before = await readFile(join(home, "proj-ok", ".horsecode", "memory.jsonl"), "utf8");
    await new MemoryStore({ home, cwd: join(home, "proj-ok") }).load();
    expect(await readFile(join(home, "proj-ok", ".horsecode", "memory.jsonl"), "utf8")).toBe(before);
  });
});

/**
 * Tags are STORED, so fixing how they are derived does nothing for memories already on disk — and the rule
 * that was fixed had been dropping the meaningful words.
 */
describe("stored tags are re-derived on load", () => {
  it("repairs an entry tagged under the old rule", async () => {
    const dir = join(home, "proj-tags", ".horsecode");
    await mkdir(dir, { recursive: true });
    const stale = {
      id: "m1", createdAt: 1, kind: "fact",
      text: "All domain exception types must derive from `DomainException`.",
      anchors: ["domainexception"],
      tags: ["types", "must", "derive"], // what the old rule produced: `domain` and `exception` stripped
    };
    await writeFile(join(dir, "memory.jsonl"), JSON.stringify(stale) + "\n", "utf8");

    const [e] = await new MemoryStore({ home, cwd: join(home, "proj-tags") }).load();

    expect(e!.tags).toEqual(expect.arrayContaining(["domain", "exception"]));
    // …and it is on disk, so the next process starts from the repaired file.
    const again = await new MemoryStore({ home, cwd: join(home, "proj-tags") }).load();
    expect(again[0]!.tags).toEqual(e!.tags);
  });

  it("leaves a correctly-tagged file byte-for-byte alone", async () => {
    const s = new MemoryStore({ home, cwd: join(home, "proj-fresh") });
    await s.add("The adapter lives in src/app/store.ts");
    const path = join(home, "proj-fresh", ".horsecode", "memory.jsonl");
    const before = await readFile(path, "utf8");
    await new MemoryStore({ home, cwd: join(home, "proj-fresh") }).load();
    expect(await readFile(path, "utf8")).toBe(before);
  });
});

/**
 * Memory belongs to the SESSION. A task worktree that kept its own would have to merge it back through its
 * branch, and with dozens of tasks touching one line-based file every task becomes a conflict.
 */
describe("a task worktree writes to its session's memory, not its own", () => {
  it("resolves the file to the session base", async () => {
    const proj = join(home, "proj");
    const base = join(proj, ".horsecode", "worktrees", "job-a", "base");
    const task = join(proj, ".horsecode", "worktrees", "job-a", "tasks", "t1");
    await mkdir(task, { recursive: true });

    await new MemoryStore({ home, cwd: task }).add("a lesson a task learned");

    // …written where the pull request is cut from, not in the task's own directory.
    const fromBase = await new MemoryStore({ home, cwd: base }).load();
    expect(fromBase.map((e) => e.text)).toEqual(["a lesson a task learned"]);
    expect(existsSync(join(task, ".horsecode", "memory.jsonl"))).toBe(false);
  });

  it("keeps two concurrent sessions' memories apart", async () => {
    const proj = join(home, "proj2");
    const a = join(proj, ".horsecode", "worktrees", "job-a", "tasks", "t1");
    const b = join(proj, ".horsecode", "worktrees", "job-b", "tasks", "t1");
    await mkdir(a, { recursive: true }); await mkdir(b, { recursive: true });
    await new MemoryStore({ home, cwd: a }).add("learned in A");
    await new MemoryStore({ home, cwd: b }).add("learned in B");
    expect((await new MemoryStore({ home, cwd: a }).load()).map((e) => e.text)).toEqual(["learned in A"]);
    expect((await new MemoryStore({ home, cwd: b }).load()).map((e) => e.text)).toEqual(["learned in B"]);
  });

  /** Two sessions both adding lines must merge, not conflict — the file is append-only by construction. */
  it("marks the file for union merge so concurrent sessions do not conflict", async () => {
    const s = new MemoryStore({ home, cwd: join(home, "proj3") });
    await s.add("something");
    const ga = await readFile(join(home, "proj3", ".horsecode", ".gitattributes"), "utf8");
    expect(ga).toContain("memory.jsonl merge=union");
  });
});

describe("memory follows the session, because the session is what ships", () => {
  /**
   * Measured on a real job: the session's inherited `memory.jsonl` was never written after the moment it was
   * copied, while the PROJECT's gained 26 uses and 85 injections during the same hour. Everything the run
   * learned landed in the reference copy and outside the pull request.
   *
   * The path logic was right — `stateRoot` resolves a session base correctly. The store is simply built when
   * the process starts, and the only directory available then is the project; the session opens later.
   */
  it("writes into the session base once a session is open", async () => {
    const root = await mkdtemp(join(tmpdir(), "mem-"));
    try {
      const base = join(root, ".horsecode", "worktrees", "job", "base");
      await mkdir(join(base, ".horsecode"), { recursive: true });

      const store = new MemoryStore({ home: root, cwd: root });
      expect(store.filePath()).toBe(join(root, ".horsecode", "memory.jsonl"));

      store.retarget(base);
      expect(store.filePath()).toBe(join(base, ".horsecode", "memory.jsonl"));
      await store.add("the session learned this", "fact");
      expect(existsSync(join(base, ".horsecode", "memory.jsonl"))).toBe(true);
      expect(existsSync(join(root, ".horsecode", "memory.jsonl"))).toBe(false); // the project is a reference

      // …and back, so the next chat turn does not write into a worktree that is finished or gone.
      store.retarget(root);
      expect(store.filePath()).toBe(join(root, ".horsecode", "memory.jsonl"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  /**
   * The cache is dropped on retarget: keeping entries loaded from one file while writing to the other is how
   * a session would overwrite the project's memory with a stale snapshot of itself.
   */
  it("reads the file it was pointed at, not the one it was built with", async () => {
    const root = await mkdtemp(join(tmpdir(), "mem-"));
    try {
      const base = join(root, ".horsecode", "worktrees", "job", "base");
      await mkdir(join(base, ".horsecode"), { recursive: true });
      await mkdir(join(root, ".horsecode"), { recursive: true });
      await writeFile(join(root, ".horsecode", "memory.jsonl"),
        `${JSON.stringify({ id: "p1", text: "project fact", kind: "fact", anchors: [], tags: [], createdAt: 1 })}
`, "utf8");
      await writeFile(join(base, ".horsecode", "memory.jsonl"),
        `${JSON.stringify({ id: "s1", text: "session fact", kind: "fact", anchors: [], tags: [], createdAt: 1 })}
`, "utf8");

      const store = new MemoryStore({ home: root, cwd: root });
      expect((await store.load()).map((e) => e.id)).toEqual(["p1"]);
      store.retarget(base);
      expect((await store.load()).map((e) => e.id)).toEqual(["s1"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

/**
 * A store that has been pointed at a session must still be readable.
 *
 * `all()` was `this.cache ?? []` — a snapshot of whatever had already been read — and `retarget`, the call
 * that points the store at a session the moment one opens, ends by clearing that cache. So every retrieval
 * after a session opened saw an empty store, for the rest of the run.
 *
 * It survived three runs because it is indistinguishable from a project with nothing to recall: the banner
 * said "746 entries" (counted before the session existed), the file held all of them, and selection returned
 * hits when run by hand against that same file. What named it was recording the MISS — `reason: empty-store,
 * available: 0` — on a role whose store demonstrably had 721 selectable entries.
 */
describe("reading the store after it is pointed somewhere new", () => {
  it("loads on demand instead of returning whatever was cached", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-mem-load-"));
    try {
      await mkdir(join(dir, ".horsecode"), { recursive: true });
      const entry = { id: "a", text: "the cargo address model", kind: "fact", anchors: [], tags: ["cargo"], createdAt: 0 };
      await writeFile(join(dir, ".horsecode", "memory.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");

      const store = new MemoryStore({ home: dir, cwd: dir });
      // Nothing has awaited load() — the retrieval path never does, because it is synchronous.
      expect(store.all().map((e) => e.id)).toEqual(["a"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("re-reads after retarget rather than going blind", async () => {
    const project = await mkdtemp(join(tmpdir(), "hc-mem-proj-"));
    try {
      const session = join(project, ".horsecode", "worktrees", "s", "base");
      for (const root of [project, session]) {
        await mkdir(join(root, ".horsecode"), { recursive: true });
        const e = { id: root === project ? "proj" : "sess", text: "x", kind: "fact", anchors: [], tags: [], createdAt: 0 };
        await writeFile(join(root, ".horsecode", "memory.jsonl"), `${JSON.stringify(e)}\n`, "utf8");
      }
      const store = new MemoryStore({ home: project, cwd: project });
      expect(store.all().map((e) => e.id)).toEqual(["proj"]);
      store.retarget(session);                                  // …the session opens
      expect(store.all().map((e) => e.id)).toEqual(["sess"]);    // …and the store follows it, still readable
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  /** A project with no memory file is genuinely empty — that answer must stay cheap and quiet. */
  it("says empty when there is nothing to read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-mem-none-"));
    try {
      expect(new MemoryStore({ home: dir, cwd: dir }).all()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Writing nothing when you have read nothing is not a save, it is an erase.
 *
 * `persist()` wrote `this.cache ?? []`, and `retarget()` sets the cache to undefined ON PURPOSE — its own
 * comment says carrying entries across "is how a session would overwrite the project's memory with a stale
 * snapshot of itself". So "not loaded" was a real, reachable state, and `?? []` turned it into an erase.
 *
 * Measured on a real project: `memory.jsonl` went from 746 entries to 1 byte after a session ended, and the
 * next start read "Rules: 0 active · Memory: 0 entries" — every rule the user had written, gone. The same
 * function's own comment says this file "was lost that way"; the guard it describes was for a torn write,
 * not for an unloaded cache.
 */
describe("an unloaded store never overwrites the file", () => {
  /** persist() is private; the point of this test is precisely that nothing else may reach it unloaded. */
  const persist = (m: MemoryStore): Promise<void> =>
    (m as unknown as { persist(): Promise<void> }).persist();

  it("refuses to write when nothing has been read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-mem-"));
    try {
      await mkdir(join(dir, ".horsecode"), { recursive: true });
      const file = join(dir, ".horsecode", "memory.jsonl");
      const kept = `${JSON.stringify({ id: "m1", text: "a rule the user wrote", kind: "rule" })}\n`;
      await writeFile(file, kept, "utf8");

      const m = new MemoryStore({ home: dir, cwd: dir });
      await persist(m);                       // never loaded
      expect(await readFile(file, "utf8")).toBe(kept);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("is unloaded again after retarget — the state the guard exists for", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-mem-"));
    try {
      await mkdir(join(dir, ".horsecode"), { recursive: true });
      const file = join(dir, ".horsecode", "memory.jsonl");
      await writeFile(file, `${JSON.stringify({ id: "m1", text: "kept", kind: "fact" })}\n`, "utf8");
      const m = new MemoryStore({ home: dir, cwd: dir });
      await m.load();
      const other = await mkdtemp(join(tmpdir(), "hc-mem-b-"));
      try {
        m.retarget(other);                    // cache dropped, by design
        m.retarget(dir);                      // …and back
        await persist(m);                     // anything reaching here must not erase
        expect((await readFile(file, "utf8")).trim().length).toBeGreaterThan(0);
      } finally { await rm(other, { recursive: true, force: true }); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("still writes normally once the store has been read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-mem-"));
    try {
      await mkdir(join(dir, ".horsecode"), { recursive: true });
      const file = join(dir, ".horsecode", "memory.jsonl");
      await writeFile(file, `${JSON.stringify({ id: "m1", text: "kept", kind: "fact" })}\n`, "utf8");
      const m = new MemoryStore({ home: dir, cwd: dir });
      await m.load();
      await m.add("something new", "fact");
      expect((await readFile(file, "utf8")).trim().split("\n").length).toBe(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

/**
 * A run that only READS memory must leave the developer's tree exactly as it found it.
 *
 * `memory.jsonl` is shared: it is committed, it carries `merge=union`, and a teammate who pulls it gets what
 * this project has learned. Injection counters are none of those things — they say how often THIS machine put
 * an entry into a prompt, and they change on every run that reads anything.
 *
 * Measured on the project this runs against: a whole session's only uncommitted change was this file, 24
 * lines differing in `injections` and `observedInjections` and nothing else. It was enough for a reviewer to
 * be handed "the diff contains only bookkeeping changes in .horsecode/memory.jsonl" as the entirety of a
 * task's work, and enough that the tree could never be clean.
 */
describe("counting injections", () => {
  const proj = (): string => join(home, "proj-a");
  const memFile = (): string => join(proj(), ".horsecode", "memory.jsonl");
  const usageFile = (): string => join(proj(), ".horsecode", USAGE_FILE);

  it("does not touch the shared file — nothing about the memories changed", async () => {
    const s = store();
    const res = await s.add("the store adapter lives in src/store.ts");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const before = await readFile(memFile(), "utf8");
    await s.recordInjection([res.entry.id]);
    expect(await readFile(memFile(), "utf8")).toBe(before);
  });

  it("never writes a count into the shared file at all", async () => {
    const s = store();
    const res = await s.add("the store adapter lives in src/store.ts");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await s.recordInjection([res.entry.id]);
    await s.add("a second fact, which rewrites the shared file");
    const shared = await readFile(memFile(), "utf8");
    expect(shared).not.toContain("observedInjections");
    expect(shared).toContain("the store adapter lives in src/store.ts");   // …the memory itself is all there
  });

  it("keeps the count in a file of its own beside it", async () => {
    const s = store();
    const res = await s.add("the store adapter lives in src/store.ts");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    await s.recordInjection([res.entry.id]);
    await s.recordInjection([res.entry.id]);
    const usage = JSON.parse(await readFile(usageFile(), "utf8")) as Record<string, { injections: number }>;
    expect(usage[res.entry.id]!.injections).toBe(2);
  });

  it("takes over the counts already written into the shared file — the move loses nothing", async () => {
    await mkdir(join(proj(), ".horsecode"), { recursive: true });
    await writeFile(memFile(), JSON.stringify({
      id: "m1", text: "an old fact", anchors: [], tags: [], createdAt: 1,
      injections: 9, observedInjections: 7,
    }) + "\n");
    const loaded = await store().load();
    expect(loaded[0]!.injections).toBe(9);
    expect(loaded[0]!.observedInjections).toBe(7);
  });

  it("writes the counts out of git, where the rest of the machine-local state already goes", async () => {
    await store().add("anything at all");
    expect(await readFile(join(proj(), ".horsecode", ".gitignore"), "utf8")).toContain(USAGE_FILE);
  });

  /**
   * A project that already has an ignore list gets the new name APPENDED, not skipped.
   *
   * Writing that file only when it was absent was right while its contents never changed. The moment a name
   * was added, every project that had used horse-code before — which is every project that has one — kept the
   * old list and got the sidecar as an untracked change instead. The fix for a dirty tree would have arrived
   * only for the projects that never had the problem.
   */
  it("adds itself to an ignore list that already exists", async () => {
    await mkdir(join(proj(), ".horsecode"), { recursive: true });
    const gi = join(proj(), ".horsecode", ".gitignore");
    await writeFile(gi, "# horse-code: local/secret state stays out of git; memory.jsonl is shared\n"
      + "config.json\nsources.json\nworktrees/\nlast-turn.json\n");
    await store().add("anything at all");
    const after = await readFile(gi, "utf8");
    expect(after).toContain(USAGE_FILE);
    expect(after).toContain("last-turn.json");   // …and everything that was already in it
  });

  it("adds it only once, however many times the store is written", async () => {
    const s = store();
    await s.add("one");
    await s.add("two");
    const after = await readFile(join(proj(), ".horsecode", ".gitignore"), "utf8");
    expect(after.split("\n").filter((l) => l.trim() === USAGE_FILE)).toHaveLength(1);
  });

  it("covers the read-only run too — the only file it writes is the sidecar", async () => {
    const first = store();
    const res = await first.add("a fact worth counting");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const gi = join(proj(), ".horsecode", ".gitignore");
    // A project whose ignore list predates the sidecar, and a session that only reads and counts.
    await writeFile(gi, "config.json\nsources.json\nworktrees/\nlast-turn.json\n");
    await store().recordInjection([res.entry.id]);
    expect(await readFile(gi, "utf8")).toContain(USAGE_FILE);
  });
});
