import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/session/memory.js";

let home: string;
let t = 0;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "hc-mem-")); t = 0; });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const store = (cwd = "/proj/a"): MemoryStore => new MemoryStore({ home, cwd, now: () => ++t });

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
    await store("/proj/a").add("only in a");
    expect(await store("/proj/b").load()).toEqual([]);
  });

  it("forgets the N-th memory (1-based); out of range → undefined", async () => {
    const s = store();
    await s.add("one"); await s.add("two"); await s.add("three");
    expect(await s.remove(2)).toBe("two");
    expect(s.all().map((e) => e.text)).toEqual(["one", "three"]);
    expect(await s.remove(9)).toBeUndefined();
  });
});
