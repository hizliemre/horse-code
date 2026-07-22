import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PinStore, MAX_PINS } from "../../src/session/pins.js";

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "hc-pins-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe("PinStore", () => {
  it("adds, lists, and persists pins across instances (per project)", async () => {
    const a = new PinStore({ home, cwd: "/proj/a" });
    expect(await a.add("use pnpm")).toEqual({ ok: true, pin: "use pnpm" });
    await a.add("target Node 22");
    expect(a.list()).toEqual(["use pnpm", "target Node 22"]);

    const reopened = new PinStore({ home, cwd: "/proj/a" });
    expect(await reopened.load()).toEqual(["use pnpm", "target Node 22"]);
  });

  it("scopes pins per project", async () => {
    const a = new PinStore({ home, cwd: "/proj/a" });
    await a.add("only in a");
    const b = new PinStore({ home, cwd: "/proj/b" });
    expect(await b.load()).toEqual([]);
  });

  it("rejects empty, duplicate, and over-limit pins", async () => {
    const s = new PinStore({ home, cwd: "/proj/a" });
    expect(await s.add("   ")).toEqual({ ok: false, error: "empty pin" });
    await s.add("x");
    expect(await s.add("x")).toEqual({ ok: false, error: "already pinned" });
    for (let i = 1; i < MAX_PINS; i++) await s.add(`pin ${i}`);
    expect(await s.add("one too many")).toEqual({ ok: false, error: `pin limit reached (${MAX_PINS})` });
  });

  it("removes the N-th pin (1-based); out of range → undefined", async () => {
    const s = new PinStore({ home, cwd: "/proj/a" });
    await s.add("a"); await s.add("b"); await s.add("c");
    expect(await s.remove(2)).toBe("b");
    expect(s.list()).toEqual(["a", "c"]);
    expect(await s.remove(9)).toBeUndefined();
  });
});
