import { describe, it, expect } from "vitest";
import { AccountPool, SPENT } from "../../src/agents/cli-accounts.js";

const pool = (): AccountPool =>
  new AccountPool([
    { name: "main", configDir: "/p/main" },
    { name: "second", configDir: "/p/second" },
  ]);

/**
 * Nothing configured is the ordinary case, and it has to stay free of all of this.
 *
 * Returning a profile here would send every call through a `CLAUDE_CONFIG_DIR` nobody asked for, and the
 * first symptom would be a CLI reporting itself logged out on a machine that plainly is not.
 */
describe("with no profiles configured", () => {
  it("names none, so the call runs under the ambient login", () => {
    expect(new AccountPool().pick()).toBeUndefined();
    expect(new AccountPool([]).pick()).toBeUndefined();
  });
});

/**
 * Spillover, not rotation: the first subscription is used until it is nearly out, and only then does the
 * next take over. Alternating between two would make two limits behave like one bigger one; this keeps a
 * run on one subscription and reaches for another when the first genuinely cannot serve.
 */
describe("choosing which subscription serves a call", () => {
  it("stays on the first while it still has room", () => {
    const p = pool();
    expect(p.pick()?.name).toBe("main");
    p.record("main", { five_hour: 0.4, seven_day: 0.1 });
    expect(p.pick()?.name).toBe("main");
    p.record("main", { five_hour: 0.9, seven_day: 0.2 });
    expect(p.pick()?.name).toBe("main");
  });

  it("moves to the next once the first is spent", () => {
    const p = pool();
    p.record("main", { five_hour: SPENT, seven_day: 0.2 });
    expect(p.pick()?.name).toBe("second");
  });

  /**
   * A long window that is gone stops a subscription as surely as a short one. Reading only `five_hour`
   * would keep sending calls to a profile whose weekly limit ran out days ago.
   */
  it("is stopped by whichever window is furthest along", () => {
    const p = pool();
    p.record("main", { five_hour: 0.05, seven_day: 0.99 });
    expect(p.pick()?.name).toBe("second");
  });

  /**
   * With everything spent there is no good answer, and refusing to name one would fail the call here — on a
   * reading that is only ever "as of that profile's last call". The limit itself is a better judge, and it
   * answers precisely; the pool's guess should not pre-empt it.
   */
  it("still names one when every profile looks spent", () => {
    const p = pool();
    p.record("main", { five_hour: 1 });
    p.record("second", { five_hour: 1 });
    expect(p.pick()?.name).toBe("second");
  });

  it("reports what each profile last said, for a status line", () => {
    const p = pool();
    p.record("main", { five_hour: 0.4, seven_day: 0.62 });
    expect(p.usage()).toEqual([
      { name: "main", spent: 0.62 },
      { name: "second", spent: undefined },
    ]);
  });
});
