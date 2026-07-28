import { describe, it, expect, afterEach } from "vitest";
import { WatchManager, shortName, MAX_LINES_PER_MIN, type WatchStatus } from "../../src/obs/watch.js";

const settle = (ms = 250): Promise<void> => new Promise((r) => setTimeout(r, ms));

let managers: WatchManager[] = [];
const make = (onLine: (s: WatchStatus, l: string) => void = () => undefined,
  onEnd: (s: WatchStatus) => void = () => undefined,
  now?: () => number): WatchManager => {
  const m = new WatchManager(onLine, onEnd, now);
  managers.push(m);
  return m;
};
afterEach(() => {
  for (const m of managers) m.stopAll();
  managers = [];
});

/**
 * The built-in run monitor answers three fixed questions about horse-code itself. That is the narrow case.
 *
 * The general one is that a person building software wants to watch things this tool knows nothing about —
 * the dev server the agents just started, a CI run, a log the app writes. There is no useful way to
 * enumerate those, so the mechanism takes a COMMAND and treats each line it prints as an event. Anything
 * that can print a line when something happens is a watch.
 */
describe("WatchManager", () => {
  it("turns each line the command prints into an event", async () => {
    const seen: string[] = [];
    const m = make((_s, l) => seen.push(l));
    m.start("printf 'first\\nsecond\\n'");
    await settle();
    expect(seen).toEqual(["first", "second"]);
  });

  /** A watch whose command is broken must say so, not fall silent and look healthy. */
  it("reports what the command writes to stderr too", async () => {
    const seen: string[] = [];
    const m = make((_s, l) => seen.push(l));
    m.start("printf 'boom\\n' 1>&2");
    await settle();
    expect(seen).toEqual(["boom"]);
  });

  /** The writer flushes when it likes; a line is only a line once its newline has arrived. */
  it("holds back a partial line until its newline arrives", async () => {
    const seen: string[] = [];
    const m = make((_s, l) => seen.push(l));
    m.start("printf 'half'; sleep 0.2; printf '%s\\n' 'and-half' 'next'");
    await settle(900);
    expect(seen).toEqual(["halfand-half", "next"]);
  });

  it("says when the command ended, and how", async () => {
    const ends: WatchStatus[] = [];
    const m = make(() => undefined, (s) => ends.push(s));
    m.start("exit 3");
    await settle();
    expect(ends).toHaveLength(1);
    expect(ends[0].alive).toBe(false);
    expect(ends[0].exit).toContain("3");
  });

  it("lists what is running, with its counts", async () => {
    const m = make();
    m.start("printf 'a\\nb\\n'; sleep 5", "my-watch");
    await settle();
    const [w] = m.list();
    expect(w.name).toBe("my-watch");
    expect(w.events).toBe(2);
    expect(w.last).toBe("b");
    expect(w.alive).toBe(true);
  });

  /**
   * A watch is a notification channel, not a log viewer: `tail -f` on a busy file would push a thousand lines
   * a minute into a conversation nobody could then read.
   */
  it("throttles a command that talks faster than anyone can read", async () => {
    const seen: string[] = [];
    let t = 0;
    const m = make((_s, l) => seen.push(l), () => undefined, () => t); // a frozen clock: one rate window
    m.start(`for i in $(seq 1 ${MAX_LINES_PER_MIN + 30}); do echo line-$i; done`);
    await settle(700);
    expect(seen.length).toBe(MAX_LINES_PER_MIN);
    expect(m.list()[0].suppressed).toBeGreaterThan(0);
  });

  /** The signal that a watch is loud must survive even when its lines do not. */
  it("counts what it suppressed rather than hiding it", async () => {
    let t = 0;
    const m = make(() => undefined, () => undefined, () => t);
    m.start(`for i in $(seq 1 ${MAX_LINES_PER_MIN + 5}); do echo x; done`);
    await settle(700);
    expect(m.list()[0].events + m.list()[0].suppressed).toBeGreaterThanOrEqual(MAX_LINES_PER_MIN + 5);
  });

  it("stops a watch on request, and says it is no longer alive", async () => {
    const m = make();
    const s = m.start("sleep 30");
    await settle();
    expect(m.stop(s.id)).toBe(true);
    await settle(400);
    expect(m.list()[0].alive).toBe(false);
  });

  it("does not pretend to stop one that already ended", async () => {
    const m = make();
    const s = m.start("true");
    await settle();
    expect(m.stop(s.id)).toBe(false);
  });

  /**
   * The lifecycle failure this project has already had once: a command started in the shared process group
   * survives being killed and keeps running — and keeps holding the terminal.
   */
  it("takes down everything the watch started, not just its shell", async () => {
    const m = make();
    const s = m.start("sleep 30 & echo $!; wait");
    await settle(400);
    const pid = Number(m.list()[0].last);
    expect(pid).toBeGreaterThan(0);
    m.stop(s.id);
    await settle(500);
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  });

  it("stopAll leaves nothing running", async () => {
    const m = make();
    m.start("sleep 30");
    m.start("sleep 30");
    await settle();
    m.stopAll();
    await settle(400);
    expect(m.list().every((w) => !w.alive)).toBe(true);
  });
});

describe("shortName", () => {
  it("names a watch after the command that runs it", () => {
    expect(shortName("tail -f app.log")).toBe("tail");
    expect(shortName("/usr/bin/gh pr checks")).toBe("gh");
  });

  it("looks past the wrappers nobody means", () => {
    expect(shortName("sudo journalctl -f")).toBe("journalctl");
    expect(shortName("env FOO=1 npm run dev")).toBe("npm");
  });

  it("always has something to call it", () => {
    expect(shortName("   ")).toBe("watch");
  });
});
