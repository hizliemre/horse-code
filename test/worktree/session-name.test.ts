import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { sessionName, WorktreeManager } from "../../src/worktree/manager.js";
import { initTmpRepo } from "./helpers.js";

let repo: string;
beforeEach(async () => { repo = await initTmpRepo(); });
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

const WED = new Date(2026, 7, 5);   // 05 Aug 2026, a Wednesday

/**
 * A session's name is the day it opened, and which one of that day it is.
 *
 * It used to be named after the request that first needed a worktree — and the first request is usually the
 * smallest. Reported live: a sitting whose real work was product-upload testing sat in
 * `hc/turkish-agent-communications/base`, named after a one-line rule asked for on the way in.
 *
 * Renaming it later fixed the name and bought a worse problem. These worktrees are meant to be RUN in —
 * start the project, look at the screen, ask for a change — and moving a directory out from under a running
 * process does not fail on macOS or Linux. It succeeds, and the watcher never sees another edit. A name that
 * never changes cannot do that.
 */
describe("what a session is called", () => {
  it("is the day it opened, with that day's index", () => {
    expect(sessionName(WED, () => false)).toBe("05-Aug-2026-WEDNESDAY_01");
  });

  it("counts up for another session the same day", () => {
    const taken = new Set(["05-Aug-2026-WEDNESDAY_01", "05-Aug-2026-WEDNESDAY_02"]);
    expect(sessionName(WED, (n) => taken.has(n))).toBe("05-Aug-2026-WEDNESDAY_03");
  });

  it("starts again at 01 on the next day", () => {
    const taken = new Set(["05-Aug-2026-WEDNESDAY_01"]);
    expect(sessionName(new Date(2026, 7, 6), (n) => taken.has(n))).toBe("06-Aug-2026-THURSDAY_01");
  });

  it("pads the day and the index, so the names sort the way they read", () => {
    expect(sessionName(new Date(2026, 0, 3), () => false)).toBe("03-Jan-2026-SATURDAY_01");
  });

  /** English, always: a name read by people must not shift with the machine's locale. */
  it("names the month and the day in English", () => {
    const names = [0, 1, 2].map((i) => sessionName(new Date(2026, 11, 25 + i), () => false));
    expect(names[0]).toContain("Dec");
    expect(names.some((n) => n.includes("FRIDAY"))).toBe(true);
  });
});

describe("the session a manager opens", () => {
  it("carries that name in its directory and its branch", async () => {
    const m = new WorktreeManager({ repoRoot: repo, now: () => WED });
    const s = await m.openSession("main", "some request nobody will read later");
    expect(s.jobSlug).toBe("05-Aug-2026-WEDNESDAY_01");
    expect(s.baseBranch).toBe("hc/05-Aug-2026-WEDNESDAY_01/base");
    expect(existsSync(s.baseWorktree)).toBe(true);
  });

  /** The request no longer decides the name — the second session of the day is simply the second. */
  it("gives the next session of the day the next index", async () => {
    const m = new WorktreeManager({ repoRoot: repo, now: () => WED });
    await m.openSession("main", "first request");
    const second = await m.openSession("main", "an entirely different request");
    expect(second.jobSlug).toBe("05-Aug-2026-WEDNESDAY_02");
  });

  /** Nothing renames a session afterwards: that is what could move a directory under a running server. */
  it("has no way to be renamed", () => {
    expect((new WorktreeManager({ repoRoot: repo }) as unknown as Record<string, unknown>).renameSession)
      .toBeUndefined();
  });
});
