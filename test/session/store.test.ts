import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type SessionMessage } from "../../src/session/store.js";

let home: string;
const msgs = (...pairs: [SessionMessage["role"], string][]): SessionMessage[] =>
  pairs.map(([role, text]) => ({ role, text }));

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hc-sess-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("save then load round-trips the messages, id, and count", async () => {
    let t = 1000;
    const s = new SessionStore({ home, cwd: "/proj/a", now: () => t });
    await s.save(msgs(["user", "build a thing"], ["assistant", "done"]));
    const loaded = await s.load(s.id);
    expect(loaded?.messages).toEqual(msgs(["user", "build a thing"], ["assistant", "done"]));
    expect(loaded?.count).toBe(2);
    expect(loaded?.id).toBe(s.id);
  });

  it("derives the title from the first user message (truncated)", async () => {
    const s = new SessionStore({ home, cwd: "/proj/a", now: () => 1 });
    await s.save(msgs(["assistant", "hi"], ["user", "  make   a  login  page  "]));
    expect((await s.load(s.id))?.title).toBe("make a login page");
    const long = "x".repeat(100);
    const s2 = new SessionStore({ home, cwd: "/proj/a", now: () => 2 });
    await s2.save(msgs(["user", long]));
    expect((await s2.load(s2.id))?.title).toBe(`${"x".repeat(59)}…`);
  });

  it("does not write a file for an empty transcript", async () => {
    const s = new SessionStore({ home, cwd: "/proj/a", now: () => 1 });
    await s.save([]);
    expect(await s.list()).toEqual([]);
  });

  it("list returns sessions newest-first", async () => {
    const a = new SessionStore({ home, cwd: "/proj/a", now: () => 100 });
    await a.save(msgs(["user", "first"]));
    const b = new SessionStore({ home, cwd: "/proj/a", now: () => 200 });
    await b.save(msgs(["user", "second"]));
    const list = await b.list();
    expect(list.map((s) => s.title)).toEqual(["second", "first"]);
    expect(list[0].updatedAt).toBe(200);
  });

  it("setActive continues an existing session (overwrite, not fork)", async () => {
    const a = new SessionStore({ home, cwd: "/proj/a", now: () => 100 });
    await a.save(msgs(["user", "hello"]));
    const original = a.id;

    const b = new SessionStore({ home, cwd: "/proj/a", now: () => 200 });
    b.setActive(original); // resume a's session
    await b.save(msgs(["user", "hello"], ["assistant", "hi"], ["user", "more"]));

    const list = await b.list();
    expect(list).toHaveLength(1); // overwritten, not forked
    expect(list[0].id).toBe(original);
    expect(list[0].count).toBe(3);
  });

  it("scopes sessions per project (different cwd → isolated)", async () => {
    const a = new SessionStore({ home, cwd: "/proj/a", now: () => 1 });
    await a.save(msgs(["user", "in a"]));
    const b = new SessionStore({ home, cwd: "/proj/b", now: () => 1 });
    expect(await b.list()).toEqual([]); // b sees none of a's sessions
    expect((await a.list()).map((s) => s.title)).toEqual(["in a"]);
  });

  it("load returns undefined for a missing id", async () => {
    const s = new SessionStore({ home, cwd: "/proj/a", now: () => 1 });
    expect(await s.load("nope")).toBeUndefined();
  });
});
