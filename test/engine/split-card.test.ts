import { describe, it, expect } from "vitest";
import { Board } from "../../src/board/board.js";
import {
  shouldSplit, failureSubjects, applySplit, splitRequest, reviewFailures, humanAbandoned,
  SPLIT_AFTER_ATTEMPTS, MIN_PIECES,
} from "../../src/engine/split-card.js";
import type { Card } from "../../src/board/board.js";

/** Verbatim shapes from the card that ended a run: 4 files declared, 19 failures, ten distinct areas. */
const FAILURES = [
  "[medium] code-plan-conformance: CreateSupplierRelation duplicate guard is check-then-insert with no DB-level backstop",
  "[critical] code-error-handling: Supplier-request notifications can be permanently lost: CreateSupplierRelation catches every publish failure",
  "[critical] code-concurrency: The identifier advisory lock does not cover the write. UpdateCompanyDetails commits Company.TaxNumber before delivery",
  "[medium] code-plan-conformance: Repo artifact damage: this change strips 3,759 lines from `graphify-out/.graphify_labels.json`",
  "[critical] code-correctness: FR-002's equal response-duration requirement is not implemented",
];

function card(over: Partial<Card> = {}): Card {
  return {
    id: "T004", title: "[US1] implement the supplier relationship lifecycle", column: "TODO",
    deps: [], acceptance: ["a relation can be created", "it can be terminated"], files: ["a.cs", "b.cs"],
    reviewNotes: [], attempts: 0,
    stageHistory: FAILURES.map((note) => ({ role: "code-reviewer", action: "reviewed:fail", note })),
    ...over,
  };
}

/**
 * The ladder answers repeated failure with a stronger model, which is right for a HARD task and wrong for a
 * BROAD one: a stronger model does not shrink the surface a reviewer has to hold. Measured on the card this
 * is built from — 19 review failures naming ten areas, then abandonment, and seventeen cards abandoned
 * behind it without ever being attempted.
 */
describe("deciding to cut a card up", () => {
  it("leaves a card alone until it has failed enough to mean something", () => {
    const fails = (n: number) => card({
      stageHistory: FAILURES.slice(0, 1).flatMap(() =>
        Array.from({ length: n }, () => ({ role: "code-reviewer", action: "reviewed:fail", note: FAILURES[0] }))),
    });
    expect(shouldSplit(fails(SPLIT_AFTER_ATTEMPTS - 1))).toBe(false);
    expect(shouldSplit(fails(SPLIT_AFTER_ATTEMPTS))).toBe(true);
  });

  /**
   * A split is not idempotent by nature, and the board makes that dangerous: the parent is retired but
   * `exhausted` parking wakes on any merge, and the first thing to merge after a split is one of its own
   * pieces. Its failure count never falls, so a second scheduling split it AGAIN — observed live, T004
   * carrying two `split:into` events, its second pair re-implementing what the first had already merged.
   */
  it("never cuts up a card that has already been replaced", () => {
    const once = card({
      stageHistory: [
        ...card().stageHistory,
        { role: "team-lead", action: "split:into", note: "19 review failures over 11 areas → T004a, T004b" },
      ],
    });
    expect(reviewFailures(once)).toBeGreaterThanOrEqual(SPLIT_AFTER_ATTEMPTS);
    expect(shouldSplit(once)).toBe(false);
  });

  /**
   * `attempts` is reset at the start of every run, so a card that failed nineteen times across four runs
   * comes back reading zero. Right for choosing a TIER, wrong for noticing a card is too big — it would need
   * five fresh failures before anyone looked.
   */
  it("counts failures over the card's life, not over this run", () => {
    const veteran = card({ attempts: 0 });   // reset by a new run, but its history is intact
    expect(reviewFailures(veteran)).toBe(FAILURES.length);
    expect(shouldSplit(veteran)).toBe(true);
  });

  /**
   * Breadth is read from what the failures TOUCHED, not from the card's declared files. The card that ended
   * the run declared four files and its failures named ten subjects; the declaration is the number that
   * looked fine.
   */
  it("reads the areas from the failures, not from the declaration", () => {
    const subjects = failureSubjects(card());
    expect(subjects).toContain("CreateSupplierRelation");
    expect(subjects).toContain("UpdateCompanyDetails");
    expect(subjects).toContain(".graphify_labels");
    expect(subjects.length).toBeGreaterThan(card().files.length);
  });

  it("counts each area once however often it is named", () => {
    const twice = card({ stageHistory: [...card().stageHistory, ...card().stageHistory] });
    expect(new Set(failureSubjects(twice)).size).toBe(failureSubjects(twice).length);
  });

  it("asks for the cut along the seams the failures exposed", () => {
    const req = splitRequest(card({ attempts: 0, reviewNotes: [FAILURES[0]] }));
    expect(req).toContain("CreateSupplierRelation");
    // The lifetime count, not the per-run counter a new run just zeroed.
    expect(req).toContain(`failed review ${FAILURES.length} times`);
    // It must not quietly become a new breakdown of its own.
    expect(req).toContain("no more, no less");
    expect(req).toContain("Do not `invent work".replace("`", ""));
  });
});

/**
 * A dependent waited for the whole of the original, so it must wait for the whole of what replaced it —
 * otherwise a split silently lets work start before its prerequisite exists.
 */
describe("replacing a card with its pieces", () => {
  const build = (): Board => {
    const b = new Board();
    b.addCard({ id: "T001", title: "root" });
    b.addCard({ id: "T004", title: "lifecycle", deps: ["T001"] });
    b.addCard({ id: "T006", title: "depends on the lifecycle", deps: ["T004"] });
    b.addCard({ id: "T007", title: "also depends", deps: ["T004", "T001"] });
    for (const n of FAILURES) b.appendStage("T004", { role: "code-reviewer", action: "reviewed:fail", note: n });
    return b;
  };
  const pieces = [
    { title: "create and list relations", acceptance: ["a relation can be created"], files: ["a.cs"] },
    { title: "respond to and terminate relations", acceptance: ["it can be terminated"], files: ["b.cs"] },
  ];

  it("creates a card per piece, in order", () => {
    const b = build();
    const ids = applySplit(b, "T004", pieces);
    expect(ids).toEqual(["T004a", "T004b"]);
    expect(b.get("T004a")!.title).toBe("create and list relations");
    expect(b.get("T004b")!.acceptance).toEqual(["it can be terminated"]);
  });

  /** The first piece inherits what the parent waited for; the rest chain, because they came from one card. */
  it("chains the pieces and gives the first the parent's dependencies", () => {
    const b = build();
    applySplit(b, "T004", pieces);
    expect(b.get("T004a")!.deps).toEqual(["T001"]);
    expect(b.get("T004b")!.deps).toEqual(["T004a"]);
  });

  it("moves everything that waited on the parent onto the last piece", () => {
    const b = build();
    applySplit(b, "T004", pieces);
    expect(b.get("T006")!.deps).toEqual(["T004b"]);
    // An unrelated dependency of the same card is left exactly as it was.
    expect(b.get("T007")!.deps.sort()).toEqual(["T001", "T004b"]);
  });

  it("retires the parent and says what became of it", () => {
    const b = build();
    applySplit(b, "T004", pieces);
    expect(b.get("T004")!.column).toBe("ABANDONED");
    const note = b.get("T004")!.stageHistory.find((h) => h.action === "split:into")?.note ?? "";
    expect(note).toContain("T004a, T004b");
    expect(note).toContain("areas");
    // The lifetime count. Live, this read "0 attempts" on the very run that cut the card up.
    expect(note).toContain(`${FAILURES.length} review failures`);
  });

  it("records on each piece where it came from", () => {
    const b = build();
    applySplit(b, "T004", pieces);
    expect(b.get("T004a")!.stageHistory[0]?.note).toContain("T004");
  });

  /**
   * One piece is not a split. The splitter answering with a single piece means it found nothing separable,
   * and rewriting the board for that would lose the card's history to no purpose.
   */
  it("changes nothing when there is nothing to separate", () => {
    const b = build();
    expect(applySplit(b, "T004", pieces.slice(0, MIN_PIECES - 1))).toEqual([]);
    expect(b.get("T004")!.column).toBe("TODO");
    expect(b.get("T006")!.deps).toEqual(["T004"]);
  });

  it("does not collide with an id the board already holds", () => {
    const b = build();
    b.addCard({ id: "T004a", title: "already taken" });
    const ids = applySplit(b, "T004", pieces);
    expect(ids).not.toContain("T004a");
    expect(b.get("T004a")!.title).toBe("already taken");
  });
});

/**
 * A split that nothing schedules is worse than no split: it replaces a card that at least ran with cards
 * that never do. `pending` is a snapshot taken before the loop, so pieces born mid-run are invisible to it
 * unless the engine goes looking.
 */
describe("the pieces reach the scheduler", () => {
  it("the wave engine absorbs cards that appear after it started", async () => {
    const src = await (await import("node:fs/promises")).readFile("src/engine/wave-engine.ts", "utf8");
    expect(src).toContain("absorbNewCards");
    // Called inside the loop, not once before it.
    const declared = src.indexOf("const absorbNewCards");
    const loop = src.indexOf("while (pending.size > 0");
    const called = src.indexOf("absorbNewCards();", loop);
    expect(declared).toBeGreaterThan(0);
    expect(called).toBeGreaterThan(loop);
  });

  /** A piece that arrives already merged is done, not pending — otherwise a resume re-runs finished work. */
  it("files an already-merged newcomer as done", async () => {
    const src = await (await import("node:fs/promises")).readFile("src/engine/wave-engine.ts", "utf8");
    expect(src).toMatch(/if \(c\.column === "MERGED"\) \{ done\.add\(c\.id\); continue; \}/);
  });
});

/**
 * A retired parent is not enough on its own. `exhausted` parking wakes on ANY merge, and the first thing to
 * merge after a split is one of its own pieces — so the parent woke, was scheduled, and did its work a
 * second time. Observed live: T004 with two `split:into` events, the second pair re-implementing behind the
 * first pair that had already merged.
 */
describe("a replaced card never runs again", () => {
  it("the wave engine drops it from pending and from parking", async () => {
    const src = await (await import("node:fs/promises")).readFile("src/engine/wave-engine.ts", "utf8");
    expect(src).toContain("wasSplit(c)");
    expect(src).toMatch(/pending\.delete\(c\.id\); parked\.delete\(c\.id\)/);
  });
});

/**
 * Abandonment by exhaustion is deliberately reversible — thirty tasks were abandoned on one board and
 * twenty-nine later passed unchanged. A human abandonment is the opposite kind of statement: a decision
 * about the work, not a report about the ladder.
 *
 * Observed: two cards retired by hand as duplicates of already-merged work were back IN-PROGRESS one minute
 * into the next run, re-implementing what had merged.
 */
describe("a card a person retired stays retired", () => {
  const abandoned = (byHuman: boolean): Card => card({
    column: "ABANDONED",
    stageHistory: [
      { role: "team-lead", action: byHuman ? "human:abandon" : "abandoned", note: "…" },
      { role: "team-lead", action: "→ABANDONED" },
    ],
  });

  it("tells a human decision from a used-up ladder", () => {
    expect(humanAbandoned(abandoned(true))).toBe(true);
    expect(humanAbandoned(abandoned(false))).toBe(false);
  });

  /** Still running is not abandoned, whatever the history says about earlier attempts. */
  it("says nothing about a card that is not abandoned now", () => {
    expect(humanAbandoned(card({ column: "TODO", stageHistory: abandoned(true).stageHistory }))).toBe(false);
  });

  it("the wave engine keeps it out of pending and out of parking", async () => {
    const src = await (await import("node:fs/promises")).readFile("src/engine/wave-engine.ts", "utf8");
    expect(src).toMatch(/!done\.has\(c\.id\) && !humanAbandoned\(c\)/);
    expect(src).toContain("wasSplit(c) || humanAbandoned(c)");
  });
});

/**
 * Guarding the wave engine was not enough. `job.ts` reopens never-tried ABANDONED cards BEFORE the engine
 * runs, and moving them out of ABANDONED erases the very mark the engine checks for — so a card retired by
 * hand was in REVIEW nine minutes into the next run, re-implementing work that had already merged.
 *
 * `attempts: 0` cannot tell the two apart: a card abandoned by hand after a run reset its counter looks
 * exactly like one that was never tried.
 */
describe("the earlier reopen respects a human decision too", () => {
  it("job.ts excludes a human abandonment from the never-tried set", async () => {
    const src = await (await import("node:fs/promises")).readFile("src/engine/job.ts", "utf8");
    const line = src.split("\n").find((l) => l.includes('c.column === "ABANDONED" && (c.attempts ?? 0) === 0')) ?? "";
    expect(line).toContain("!humanAbandoned(c)");
  });
});
