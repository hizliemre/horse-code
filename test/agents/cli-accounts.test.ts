import { describe, it, expect } from "vitest";
import { AccountPool, SPENT, readingKey } from "../../src/agents/cli-accounts.js";
import type { Reading, UsageStore } from "../../src/agents/cli-accounts.js";

const pool = (): AccountPool =>
  new AccountPool([
    { kind: "claude", name: "main", configDir: "/p/main" },
    { kind: "claude", name: "second", configDir: "/p/second" },
  ]);

/**
 * Nothing configured is the ordinary case, and it has to stay free of all of this.
 *
 * Returning a profile here would send every call through a profile directory nobody asked for, and the
 * first symptom would be a CLI reporting itself logged out on a machine that plainly is not.
 */
describe("with no profiles configured", () => {
  it("names none, so the call runs under the ambient login", () => {
    expect(new AccountPool().pick("claude")).toBeUndefined();
    expect(new AccountPool([]).pick("codex")).toBeUndefined();
  });
});

/**
 * Accounts of one kind take turns, and a spent one steps out.
 *
 * The first design drained one subscription before starting the next. Turns are better over a long run: two
 * accounts used alternately drain their windows at the same rate, so both refill in parallel. Spillover
 * empties one window while the other sits full — the same capacity, arranged to run out sooner.
 */
describe("choosing which subscription serves a call", () => {
  it("takes turns between the accounts of one kind", () => {
    const p = pool();
    expect(p.pick("claude")?.name).toBe("main");
    expect(p.pick("claude")?.name).toBe("second");
    expect(p.pick("claude")?.name).toBe("main");
  });

  it("drops a spent account out of the rotation", () => {
    const p = pool();
    p.record("claude", "main", { five_hour: SPENT, seven_day: 0.2 });
    expect(p.pick("claude")?.name).toBe("second");
    expect(p.pick("claude")?.name).toBe("second");
  });

  /**
   * A long window that is gone stops a subscription as surely as a short one. Reading only `five_hour`
   * would keep sending calls to a profile whose weekly limit ran out days ago.
   */
  it("is stopped by whichever window is furthest along", () => {
    const p = pool();
    p.record("claude", "main", { five_hour: 0.05, seven_day: 0.99 });
    expect(p.pick("claude")?.name).toBe("second");
  });

  /** A reading that says there is room again puts an account straight back into the rotation. */
  it("lets a recovered account rejoin", () => {
    const p = pool();
    p.record("claude", "main", { five_hour: 1 });
    expect(p.pick("claude")?.name).toBe("second");
    p.record("claude", "main", { five_hour: 0.1 });
    const seen = new Set([p.pick("claude")?.name, p.pick("claude")?.name]);
    expect(seen).toEqual(new Set(["main", "second"]));
  });

  /**
   * With everything spent there is no good answer, and refusing to name one would fail the call here — on a
   * reading that is only ever "as of that profile's last call". The limit itself is a better judge.
   */
  it("still names one when every profile looks spent", () => {
    const p = pool();
    p.record("claude", "main", { five_hour: 1 });
    p.record("claude", "second", { five_hour: 1 });
    expect(p.pick("claude")).toBeDefined();
  });
});

/**
 * A Claude profile and a Codex profile are different worlds — different subscriptions, different sign-ins,
 * different directories. Offered across, a binary would be pointed at a directory belonging to something
 * else, and one CLI's spent limit would push calls off a CLI that has not been touched.
 */
describe("keeping the two CLIs' profiles apart", () => {
  const mixed = (): AccountPool =>
    new AccountPool([
      { kind: "claude", name: "anth", configDir: "/p/anth" },
      { kind: "codex", name: "oai", configDir: "/p/oai" },
    ]);

  it("offers a call only profiles of its own kind", () => {
    expect(mixed().pick("claude")?.name).toBe("anth");
    expect(mixed().pick("codex")?.name).toBe("oai");
  });

  it("does not let one kind's spent limit move the other", () => {
    const p = mixed();
    p.record("claude", "anth", { five_hour: 1 });
    // Only one Codex profile exists and nothing has been spent on it.
    expect(p.pick("codex")?.name).toBe("oai");
  });

  /** Turns are per source: taking a Claude turn must not advance Codex's place in its own rotation. */
  it("keeps each kind's turn separate", () => {
    const p = new AccountPool([
      { kind: "claude", name: "c1", configDir: "/1" },
      { kind: "claude", name: "c2", configDir: "/2" },
      { kind: "codex", name: "x1", configDir: "/3" },
      { kind: "codex", name: "x2", configDir: "/4" },
    ]);
    expect(p.pick("claude")?.name).toBe("c1");
    expect(p.pick("codex")?.name).toBe("x1");
    expect(p.pick("claude")?.name).toBe("c2");
    expect(p.pick("codex")?.name).toBe("x2");
  });

  it("counts profiles overall and per CLI", () => {
    expect(mixed().count()).toBe(2);
    expect(mixed().count("claude")).toBe(1);
    expect(mixed().count("codex")).toBe(1);
  });
});

/**
 * A reading only ever arrives WITH a call, so a fresh process knows nothing until it has already spent from
 * a subscription. That is backwards for a summary printed at startup — the one moment a person wants to know
 * what is left BEFORE committing a run to it.
 */
describe("readings that survive between sessions", () => {
  const fake = (seed: Record<string, Reading> = {}): UsageStore & { saved: Record<string, Reading> } => {
    const box = { saved: seed, load: () => seed, save(r: Record<string, Reading>) { box.saved = r; } };
    return box;
  };

  it("skips an account the last session measured as spent", () => {
    const store = fake({ [readingKey("claude", "main")]: { spent: 0.99, at: 1_000 } });
    const p = new AccountPool(
      [
        { kind: "claude", name: "main", configDir: "/p/main" },
        { kind: "claude", name: "second", configDir: "/p/second" },
      ],
      store,
    );
    // Without the stored reading this would pick "main" and push straight into a limit already known to be gone.
    expect(p.pick("claude")?.name).toBe("second");
  });

  it("writes each new reading through, with the time it was taken", () => {
    const store = fake();
    const p = new AccountPool([{ kind: "claude", name: "main", configDir: "/p/main" }], store);
    p.record("claude", "main", { five_hour: 0.42 }, 5_000);
    expect(store.saved).toEqual({ [readingKey("claude", "main")]: { spent: 0.42, at: 5_000 } });
  });

  it("reports every profile with its reading, and says nothing about one never called", () => {
    const store = fake({ [readingKey("claude", "main")]: { spent: 0.3, at: 7_000 } });
    const p = new AccountPool(
      [
        { kind: "claude", name: "main", configDir: "/p/main" },
        { kind: "codex", name: "oai", configDir: "/p/oai" },
      ],
      store,
    );
    expect(p.usage()).toEqual([
      { account: { kind: "claude", name: "main", configDir: "/p/main" }, reading: { spent: 0.3, at: 7_000 } },
      { account: { kind: "codex", name: "oai", configDir: "/p/oai" } },
    ]);
  });
});
