import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/session/memory.js";

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
