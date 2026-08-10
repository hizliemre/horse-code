import { describe, it, expect } from "vitest";
import { memoryHints, reinforceUsed, reinforceTouched, emitBatchInjection, memoryNote, type MemoryEvent } from "../../src/engine/memory-inject.js";
import type { MemoryEntry } from "../../src/engine/memory-retrieval.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";

const mem = (over: Partial<MemoryEntry> & { id: string; text: string }): MemoryEntry =>
  ({ anchors: [], tags: [], createdAt: 0, ...over });

const deps = (entries: MemoryEntry[], reinforce?: (id: string) => void): TaskCycleDeps =>
  ({ memory: () => entries, ...(reinforce ? { reinforceMemory: reinforce } : {}) } as unknown as TaskCycleDeps);

describe("memoryHints (memory for every role, not just the coach)", () => {
  it("returns the relevant facts/lessons as an injectable message", () => {
    const entries = [
      mem({ id: "a", text: "the store adapter lives in src/store.ts", anchors: ["src/store.ts"], tags: ["store"] }),
      mem({ id: "b", text: "unrelated note about billing", anchors: ["src/billing.ts"], tags: ["billing"] }),
    ];
    const { message, ids } = memoryHints(deps(entries), "refactor src/store.ts persistence");
    expect(ids).toEqual(["a"]);
    expect(message).toContain("src/store.ts");
    expect(message).not.toContain("billing");
  });

  it("never re-injects RULES — they already ride every system prompt", () => {
    const entries = [mem({ id: "r", text: "always answer in Turkish", kind: "rule", tags: ["turkish"] })];
    expect(memoryHints(deps(entries), "answer in turkish please").ids).toEqual([]);
  });

  it("is a no-op when there is no memory at all", () => {
    for (const d of [deps([]), {} as TaskCycleDeps]) {
      const r = memoryHints(d, "anything");
      expect(r.message).toBe("");
      expect(r.ids).toEqual([]);
      expect(r.hits).toEqual([]);
    }
  });
});

describe("reinforceUsed", () => {
  it("credits only the memories the output actually referenced", () => {
    const entries = [
      mem({ id: "a", text: "the store adapter lives in src/store.ts", anchors: ["src/store.ts"] }),
      mem({ id: "b", text: "billing uses src/billing.ts", anchors: ["src/billing.ts"] }),
    ];
    const bumped: string[] = [];
    reinforceUsed(deps(entries, (id) => bumped.push(id)), ["a", "b"], "I updated src/store.ts as noted.");
    expect(bumped).toEqual(["a"]);
  });
});

describe("cooldown through memoryHints", () => {
  it("the same memory is not re-injected on the next call for the same topic", async () => {
    const { InjectionLog } = await import("../../src/engine/memory-retrieval.js");
    const entries = [mem({ id: "a", text: "the store adapter lives in src/store.ts", anchors: ["src/store.ts"], tags: ["store"] })];
    const d = { memory: () => entries, injectionLog: new InjectionLog() } as unknown as TaskCycleDeps;
    expect(memoryHints(d, "touching src/store.ts").ids).toEqual(["a"]); // first time: injected
    expect(memoryHints(d, "touching src/store.ts").ids).toEqual([]);    // still fresh in context
  });
});

// ── Observability ─────────────────────────────────────────────────────────────────────────────────────────
// Injection used to be entirely invisible: "no memory applied" and "memory is broken" looked identical, and
// there was no way to tell whether an injected hint was ever actually used.
describe("memory events", () => {
  const withSinks = (entries: MemoryEntry[]) => {
    const events: MemoryEvent[] = [];
    const injected: string[][] = [];
    const d = {
      memory: () => entries,
      onMemory: (ev: MemoryEvent) => events.push(ev),
      recordInjection: (ids: string[]) => injected.push(ids),
      reinforceMemory: () => {},
    } as unknown as TaskCycleDeps;
    return { d, events, injected };
  };
  const store = mem({ id: "a", text: "the store adapter lives in src/store.ts", anchors: ["src/store.ts"], tags: ["store"] });

  it("reports what was injected, for which role", () => {
    const { d, events } = withSinks([store]);
    memoryHints(d, "refactor src/store.ts", { role: "coder" });
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.kind).toBe("injected");
    if (ev.kind === "injected") {
      expect(ev.role).toBe("coder");
      expect(ev.hits.map((h) => h.entry.id)).toEqual(["a"]);
    }
  });

  it("records a durable injection count so 'never relevant' can be told from 'never came up'", () => {
    const { d, injected } = withSinks([store]);
    memoryHints(d, "refactor src/store.ts", { role: "coder" });
    expect(injected).toEqual([["a"]]);
  });

  it("emits nothing when nothing was selected — silence is not a report", () => {
    const { d, events, injected } = withSinks([store]);
    memoryHints(d, "a completely unrelated question", { role: "coder" });
    expect(events).toEqual([]);
    expect(injected).toEqual([]);
  });

  it("silent callers get the hints without the note (fan-outs report once, not per member)", () => {
    const { d, events } = withSinks([store]);
    const r = memoryHints(d, "refactor src/store.ts", { role: "coder", silent: true });
    expect(r.ids).toEqual(["a"]);
    expect(events).toEqual([]);
  });

  it("emitBatchInjection folds a fan-out into one event", () => {
    const { d, events } = withSinks([store]);
    const parts = ["lens-a", "lens-b"].map((role) => memoryHints(d, "refactor src/store.ts", { role, silent: true }));
    emitBatchInjection(d, "team:code", parts);
    expect(events).toHaveLength(1);
    if (events[0].kind === "injected") {
      expect(events[0].role).toBe("team:code");
      // The pool is the same pool seen twice, not two pools.
      expect(events[0].stats.considered).toBe(1);
    }
  });

  it("does nothing when the fan-out selected nothing at all", () => {
    const { d, events } = withSinks([store]);
    emitBatchInjection(d, "team:code", [memoryHints(d, "unrelated", { role: "x", silent: true })]);
    expect(events).toEqual([]);
  });

  it("reports a memory that actually paid off", () => {
    const { d, events } = withSinks([store]);
    reinforceUsed(d, ["a"], "I updated src/store.ts as noted", "coder");
    expect(events).toEqual([{ kind: "used", role: "coder", texts: [store.text] }]);
  });

  it("stays quiet when the output never referenced the hint", () => {
    const { d, events } = withSinks([store]);
    reinforceUsed(d, ["a"], "I did something else entirely", "coder");
    expect(events).toEqual([]);
  });
});

describe("memoryNote", () => {
  const hit = (id: string, text: string, via: "query" | "graph" = "query") =>
    ({ entry: mem({ id, text }), relevance: 0.9, score: 0.9, via } as const);
  const stats = { considered: 5, belowThreshold: 0, cooldown: 2, audience: 1, inactive: 0, budget: 0 };

  it("names the role, the count and why the rest was skipped", () => {
    const note = memoryNote({ kind: "injected", role: "coder", hits: [hit("a", "use pnpm")], stats });
    expect(note).toContain("coder");
    expect(note).toContain("1 hint");
    expect(note).toContain("2 on cooldown");
    expect(note).toContain("1 for other roles");
  });

  it("marks a graph-sourced hint so an unexpected memory is explainable", () => {
    expect(memoryNote({ kind: "injected", role: "coder", hits: [hit("a", "x", "graph")], stats })).toContain("🔗");
  });

  it("has nothing to say about an empty injection", () => {
    expect(memoryNote({ kind: "injected", role: "coder", hits: [], stats })).toBeUndefined();
  });

  it("reports hygiene and extraction", () => {
    expect(memoryNote({ kind: "hygiene", merged: 2, candidates: 1 })).toContain("merged 2 duplicate");
    expect(memoryNote({ kind: "hygiene", merged: 0, candidates: 0 })).toBeUndefined();
    expect(memoryNote({ kind: "learned", texts: ["a lesson"] })).toContain("a lesson");
  });

  it("clips long memory text so one note cannot swallow the transcript", () => {
    const note = memoryNote({ kind: "injected", role: "coder", hits: [hit("a", "x".repeat(500))], stats });
    expect(note!.length).toBeLessThan(300);
  });
});

describe("reinforceTouched (an implementer is judged by the files it went to, not by what it says)", () => {
  const entries = [
    mem({ id: "wire", text: "filter/sort already exists in src/app/core/models/repository.ts — wire it, do not reimplement it", anchors: ["src/app/core/models/repository.ts"] }),
    mem({ id: "other", text: "billing lives elsewhere", anchors: ["src/billing.ts"] }),
  ];

  it("credits a memory whose anchor the implementer actually wrote to", () => {
    const bumped: string[] = [];
    reinforceTouched(deps(entries, (id) => bumped.push(id)), ["wire", "other"], ["src/app/core/models/repository.ts"], "coder");
    expect(bumped).toEqual(["wire"]);
  });

  it("matches an anchor written as a repo path against an absolute one, and ignores case", () => {
    const bumped: string[] = [];
    reinforceTouched(deps(entries, (id) => bumped.push(id)), ["wire"], ["/Users/x/proj/SRC/app/core/models/Repository.ts"], "coder");
    expect(bumped).toEqual(["wire"]);
  });

  it("credits nothing when the implementer went somewhere else entirely", () => {
    const bumped: string[] = [];
    const seen: MemoryEvent[] = [];
    const d = { ...deps(entries, (id) => bumped.push(id)), onMemory: (e: MemoryEvent) => seen.push(e) } as unknown as TaskCycleDeps;
    reinforceTouched(d, ["wire"], ["src/app/features/task-filters.component.ts"], "coder");
    expect(bumped).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("is a no-op with no hints or no writes", () => {
    const bumped: string[] = [];
    const d = deps(entries, (id) => bumped.push(id));
    reinforceTouched(d, [], ["src/app/core/models/repository.ts"], "coder");
    reinforceTouched(d, ["wire"], [], "coder");
    expect(bumped).toEqual([]);
  });

  it("reports the use so the run can show that memory did something", () => {
    const seen: MemoryEvent[] = [];
    const d = { ...deps(entries), onMemory: (e: MemoryEvent) => seen.push(e) } as unknown as TaskCycleDeps;
    reinforceTouched(d, ["wire"], ["src/app/core/models/repository.ts"], "senior-coder");
    expect(seen).toEqual([{ kind: "used", role: "senior-coder", texts: [entries[0]!.text] }]);
  });
});

/**
 * Memory was working and unmeasurable.
 *
 * Measured on a 53-call run: 2,111 `process.memory` samples in the telemetry log and not one record of an
 * injection. The chat event above reaches the screen and nowhere else, so "which memories did this run use,
 * and what did they cost?" could only be answered by watching it happen — the same position the constitution
 * was in before it was labelled, and the reason its failure went unnoticed for two runs.
 */
describe("what the log says about memory", () => {
  const entries = [
    mem({ id: "a", text: "The filter/sort logic already exists in repository.ts", tags: ["filter", "sort", "repository"], anchors: ["src/repository.ts"] }),
    mem({ id: "b", text: "Something else entirely about invoicing", tags: ["invoice"] }),
  ];

  it("records what was injected, for whom, and how big it was", async () => {
    const { MemorySink } = await import("../../src/obs/sink.js");
    const { Telemetry, setTelemetry } = await import("../../src/obs/telemetry.js");
    const sink = new MemorySink();
    setTelemetry(new Telemetry(sink));

    const hints = memoryHints(deps(entries), "the filter and sort in repository", { role: "coder" });
    expect(hints.ids.length).toBeGreaterThan(0);

    const ev = sink.records.filter((e) => e.name === "memory.injected");
    expect(ev).toHaveLength(1);
    const a = ev[0].attributes as Record<string, unknown>;
    expect(a["hc.role"]).toBe("coder");
    expect(a["hc.memory.count"]).toBe(hints.ids.length);
    expect(a["hc.memory.ids"]).toContain("a");
    expect(a["hc.memory.chars"]).toBe(hints.message.length);
    // …and why the rest were left out, which is what a selection that drops everything needs to explain.
    expect(String(a["hc.memory.rejected"])).toMatch(/below:\d+ cooldown:\d+ audience:\d+ inactive:\d+ budget:\d+/);
  });

  /** The count is meaningless without its denominator: what was used, against what was sent. */
  it("records what was actually used, and by which credit path", async () => {
    const { MemorySink } = await import("../../src/obs/sink.js");
    const { Telemetry, setTelemetry } = await import("../../src/obs/telemetry.js");
    const sink = new MemorySink();
    setTelemetry(new Telemetry(sink));

    reinforceTouched(deps(entries), ["a", "b"], ["src/repository.ts"], "coder");
    const touched = sink.records.filter((e) => e.name === "memory.used");
    expect(touched).toHaveLength(1);
    expect(touched[0].attributes["hc.memory.via"]).toBe("anchor");
    expect(touched[0].attributes["hc.memory.used"]).toBe(1);
    expect(touched[0].attributes["hc.memory.injected"]).toBe(2);

    reinforceUsed(deps(entries), ["a", "b"], "I reused the filter/sort logic already in repository.ts", "coach");
    const cited = sink.records.filter((e) => e.name === "memory.used" && e.attributes["hc.memory.via"] === "cited");
    expect(cited).toHaveLength(1);
  });

  it("says nothing when nothing was selected", async () => {
    const { MemorySink } = await import("../../src/obs/sink.js");
    const { Telemetry, setTelemetry } = await import("../../src/obs/telemetry.js");
    const sink = new MemorySink();
    setTelemetry(new Telemetry(sink));
    memoryHints(deps(entries), "nothing here matches this query at all whatsoever", { role: "coder" });
    expect(sink.records.filter((e) => e.name === "memory.injected")).toHaveLength(0);
  });
});

/**
 * The tester was the last role running blind.
 *
 * Measured on one run through `govern → verify → fix`: 721 memories in the store, 551 model calls, and not
 * one memory reaching any of them. The gap was invisible until injection was recorded in telemetry — the
 * mechanism was working perfectly on the paths that used it and simply was not wired into this one. The
 * tester is the clearest case for it: "the environment needs X running" is what a previous session paid a
 * developer's attention to establish, and re-learning it costs another round trip through them.
 */
describe("which roles are handed what earlier runs learned", () => {
  const src = async (f: string): Promise<string> => (await import("node:fs/promises")).readFile(f, "utf8");

  it("includes the tester, which verifies against a live environment", async () => {
    const s = await src("src/engine/verify.ts");
    expect(s).toContain('memoryHints(deps, subject ?? message, { role: "tester" })');
    // …ahead of the request, so what was learned frames what is about to be checked.
    expect(s).toContain("...(hints?.message ? [{ role: \"user\" as const, content: hints.message }] : []),");
  });

  /** Injecting without crediting teaches the store that memories were SENT, which is not what it needs to rank. */
  it("credits what the tester actually used", async () => {
    const s = await src("src/engine/verify.ts");
    expect(s).toContain('reinforceUsed(deps, hints.ids, last.content ?? "", "tester")');
  });

  /** The fixer already had it — through the implementer, which credits by the files it touched. */
  it("leaves the fixer's existing path alone", async () => {
    const s = await src("src/engine/implementer.ts");
    expect(s).toContain("memoryHints(deps,");
    expect(s).toContain("reinforceTouched(deps, hints.ids, touched, role)");
  });
});

/**
 * Memory is retrieved on the SUBJECT, not on the message that carries it.
 *
 * Scoring is lexical, and a phase message is mostly instructions: where to write, what shape the document
 * takes, what to do if one already exists. Those words are identical on every call, so they are what the
 * scorer matches on — and the one part that differs, the user's actual request, gets outvoted.
 *
 * Measured against a real 746-memory store, three unrelated requests wrapped in the same 2,273-character
 * tester message returned the SAME five memories every time (`npm install`, `npm audit`, `git branch
 * --merged`). Asked by subject, each returned its own: the wizard request got "product creation is a
 * draft-first six-step wizard", the cargo request got the cargo address model, the wallet request got the
 * live balance rule.
 */
describe("what memory is retrieved on", () => {
  const store = [
    mem({ id: "wizard", text: "Product creation is a draft-first six-step wizard", tags: ["wizard", "product", "draft"] }),
    mem({ id: "cargo", text: "Cargo address model is semantic-role based", tags: ["cargo", "address", "carrier"] }),
    // The shape that wins when the boilerplate is the query: it is about the words every instruction uses.
    mem({ id: "process", text: "As soon as a scenario passes, record it in the document with its evidence",
          tags: ["document", "record", "scenario", "evidence", "results"] }),
  ];
  const BOILERPLATE =
    "FIRST, find out whether a test document for this work already exists. Search the repository. "
    + "A document that already exists is CONTINUED, never replaced. It holds results someone established and "
    + "evidence they gathered. Record each scenario in the document with its evidence before the next.";

  const ids = (q: string): string[] =>
    memoryHints(deps(store), q, { role: "tester" }).ids.sort();

  it("tells two different requests apart", () => {
    expect(ids("the product creation wizard draft")).toEqual(["wizard"]);
    expect(ids("the cargo address carrier")).toEqual(["cargo"]);
  });

  /**
   * Wrapped in the instructions, the request drags in memories that are about the INSTRUCTIONS.
   *
   * Here that shows as one extra hit; in a real store it is decisive, because the boilerplate matches
   * hundreds of memories and the budget is five — measured, three unrelated requests came back with the
   * same five, none of them about any of the requests.
   */
  it("drags in memories that are about the boilerplate, not the request", () => {
    for (const req of ["the product creation wizard draft", "the cargo address carrier"]) {
      const withMessage = ids(`${req}\n\n${BOILERPLATE}`);
      const bySubject = ids(req);
      expect(withMessage, req).toContain("process");   // …matched on "document/record/evidence"
      expect(bySubject, req).not.toContain("process"); // …which the request itself never mentions
    }
  });

  it("is the subject at both call sites that assemble a message", async () => {
    const { readFile } = await import("node:fs/promises");
    expect(await readFile("src/engine/verify.ts", "utf8"))
      .toContain('memoryHints(deps, subject ?? message, { role: "tester" })');
    expect(await readFile("src/speckit/phases.ts", "utf8"))
      .toContain("memoryHints(p.deps, subject ?? message, { role })");
  });

  /** …and the tester's callers actually pass it, or the fallback quietly restores the old behaviour. */
  it("is passed by the tester's callers", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/engine/verify.ts", "utf8");
    for (const call of src.match(/runTester\(deps[^;]*\);/g) ?? []) {
      expect(call, call).toMatch(/law, prompt\);$/);
    }
  });
});

/**
 * Every role that JUDGES or DECIDES sees what earlier runs learned.
 *
 * Audited after the tester turned out to be running blind: four more were. The coach had memory but through
 * a hand-rolled copy of this module's bookkeeping, which kept the cooldown and dropped the rest — so the
 * durable "shown N times, never cited" count that hygiene prunes on had no data from the role the user talks
 * to most, and neither the chat event nor the telemetry record ever fired for it.
 *
 * Asserted on the source: each of these assembles an agent from a dozen inputs, and what is being pinned is
 * that memory is one of them.
 */
describe("the roles that decide, and what they know", () => {
  const src = async (f: string): Promise<string> => (await import("node:fs/promises")).readFile(f, "utf8");

  it("routes the coach through this module rather than its own copy", async () => {
    const s = await src("src/engine/coach.ts");
    expect(s).toContain('memoryHints(deps, prompt, { load, role: "coach" })');
    expect(s).toContain('reinforceUsed(deps, hints.ids, msg.content, "coach")');
    // The hand-rolled path is gone — it is what dropped recordInjection and the events.
    expect(s).not.toContain("selectMemories(");
    expect(s).not.toContain("deps.injectionLog?.record(");
  });

  /** Two gates judge the same code with the same role; only one of them could see the store. */
  it("includes the acceptance gate, not only the per-task reviewer", async () => {
    const s = await src("src/engine/acceptance.ts");
    expect(s).toContain('{ role: "code-reviewer" }');
    expect(s).toContain("reinforceUsed(deps, hints.ids,");
  });

  /** Sizing decides how much machinery everything after it buys — the costliest judgement in the lane. */
  it("includes the triage that sizes a finding", async () => {
    const s = await src("src/engine/triage.ts");
    expect(s).toContain('{ role: "analyst" }');
    expect(s).toContain('reinforceUsed(deps, hints.ids, t.reason, "analyst")');
  });

  /** A file that conflicts repeatedly is the file someone already wrote down how to treat. */
  it("includes the conflict resolver, retrieved on the conflicted paths", async () => {
    const s = await src("src/engine/conflict.ts");
    expect(s).toContain('memoryHints(deps, conflicted.join(" "), { role: "operational" })');
    expect(s).toContain('reinforceTouched(deps, hints.ids, conflicted, "operational")');
  });

  /**
   * …and the mechanical roles still do not, deliberately. Each rewrites, routes or labels rather than
   * reasoning about the project, so a memory would be prompt weight with nothing to apply it to — and
   * `memory-consolidate` operating on the store it was retrieved from is a loop, not a feature.
   */
  it("leaves the mechanical roles out", async () => {
    for (const f of ["src/engine/refiner.ts", "src/engine/routing.ts", "src/engine/normalize-question.ts",
                     "src/engine/memory-consolidate.ts", "src/engine/constitution-store.ts", "src/engine/pr-summary.ts"]) {
      expect(await src(f), f).not.toContain("memoryHints(");
    }
  });
});

/**
 * A miss is recorded, and says which miss it was.
 *
 * Two ways to inject nothing, both silent: an empty store and a store where nothing matched. A log showing
 * no injections could not tell them apart — measured on an 82-call run with 746 memories on disk and
 * selection returning five hits for the same role when run by hand, three facts that could not all be true
 * and no record able to say which was wrong.
 */
describe("when memory injects nothing", () => {
  const sink = async (): Promise<{ records: { name: string; attributes: Record<string, unknown> }[] }> => {
    const { MemorySink } = await import("../../src/obs/sink.js");
    const { Telemetry, setTelemetry } = await import("../../src/obs/telemetry.js");
    const s = new MemorySink();
    setTelemetry(new Telemetry(s));
    return s as never;
  };

  it("says the store was empty when it was", async () => {
    const s = await sink();
    memoryHints(deps([]), "anything", { role: "analyst" });
    const m = s.records.filter((r) => r.name === "memory.missed");
    expect(m).toHaveLength(1);
    expect(m[0].attributes["hc.memory.reason"]).toBe("empty-store");
    expect(m[0].attributes["hc.memory.available"]).toBe(0);
  });

  /** Rules ride every prompt already, so a store of nothing but rules has nothing to select. */
  it("counts a rules-only store as empty to select from", async () => {
    const s = await sink();
    memoryHints(deps([mem({ id: "r", text: "always answer in Turkish", kind: "rule" })]), "anything", { role: "analyst" });
    const m = s.records.filter((r) => r.name === "memory.missed");
    expect(m[0].attributes["hc.memory.reason"]).toBe("empty-store");
    expect(m[0].attributes["hc.memory.available"]).toBe(1);   // …one entry on disk
    expect(m[0].attributes["hc.memory.considered"]).toBe(0);  // …and none of it selectable
  });

  it("says nothing matched, with the count it looked through", async () => {
    const s = await sink();
    const store = [mem({ id: "a", text: "cargo address model", tags: ["cargo", "address"] })];
    memoryHints(deps(store), "an unrelated question about invoicing schedules", { role: "analyst" });
    const m = s.records.filter((r) => r.name === "memory.missed");
    expect(m[0].attributes["hc.memory.reason"]).toBe("no-match");
    expect(m[0].attributes["hc.memory.considered"]).toBe(1);
    expect(String(m[0].attributes["hc.memory.rejected"])).toContain("below:1");
  });

  it("records a hit as a hit, not a miss", async () => {
    const s = await sink();
    const store = [mem({ id: "a", text: "cargo address model", tags: ["cargo", "address"] })];
    memoryHints(deps(store), "the cargo address", { role: "analyst" });
    expect(s.records.filter((r) => r.name === "memory.missed")).toHaveLength(0);
    expect(s.records.filter((r) => r.name === "memory.injected")).toHaveLength(1);
  });
});

/**
 * A role that injects memory and never credits it reports zero uses forever.
 *
 * Measured on one 3,966-call run: `correctness-judge` cited 92% of what it was given, `plan-api-contracts`
 * 100% — and `planner` 30 injections / 0 uses, `project-manager` 36 / 0, `coder` 155 / 1. The zeros were not
 * evidence that memory did not help those roles; they were roles with no path to say so. A memory that is
 * used and cannot report it looks identical to one that is dead weight, and hygiene prunes on exactly that.
 */
describe("every role that injects can also credit", () => {
  const src = async (f: string): Promise<string> => (await import("node:fs/promises")).readFile(f, "utf8");

  it("credits the document a spec-kit phase produced", async () => {
    const s = await src("src/speckit/phases.ts");
    expect(s).toContain("reinforceUsed(p.deps, hints.ids, said.content, role)");
  });

  it("credits the breakdown a project-manager produced", async () => {
    const s = await src("src/engine/job.ts");
    expect(s).toContain('reinforceUsed(deps, pm.ids, boardText(board), "project-manager")');
    // …including the repaired one, or a breakdown that had to be fixed would score nothing.
    expect(s).toContain('reinforceUsed(deps, repair.ids, boardText(board), "project-manager")');
  });

  /**
   * The implementer had a credit path that could only reach a ninth of the store: `reinforceTouched` needs a
   * FILE anchor, and of 721 selectable memories only 67 have one.
   */
  it("credits the implementer by what it wrote, as well as where it went", async () => {
    const s = await src("src/engine/implementer.ts");
    expect(s).toContain("reinforceTouched(deps, hints.ids, touched, role)");
    expect(s).toContain("reinforceUsed(deps, hints.ids, await writtenText(cwd, touched), role)");
  });

  /** …and no role is left injecting with nothing to report it by. */
  it("leaves no injector without a credit path", async () => {
    for (const f of ["src/speckit/phases.ts", "src/engine/job.ts", "src/engine/implementer.ts",
                     "src/engine/review.ts", "src/engine/reviewer.ts", "src/engine/revision.ts",
                     "src/engine/verify.ts", "src/engine/coach.ts", "src/engine/triage.ts",
                     "src/engine/acceptance.ts", "src/engine/conflict.ts"]) {
      const s = await src(f);
      if (!s.includes("memoryHints(")) continue;
      expect(s, f).toMatch(/reinforce(Used|Touched)\(/);
    }
  });
});
