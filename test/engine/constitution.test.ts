import { describe, it, expect } from "vitest";
import {
  parseConstitution, scopesForWork, selectRules, applyLabels, classifyMessage,
  CLASSIFY_PROMPT, MAX_CONSTITUTION_CHARS, SCOPES, labellingLooksWrong, MAX_ALWAYS_SHARE,
  type ScopedRule,
} from "../../src/engine/constitution.js";

const DOC = `# Parrot Constitution

## Core Principles

### I. Kaynaktan Doğrulama — Tahmin Yasak (NON-NEGOTIABLE)

"Muhtemelen" gibi kaçamak ifadeler YASAKTIR.

*Gerekçe:* Tahmin, doğrulanmamış bilgidir.

### VII. Angular Modern Pattern Disiplini

Inline template YASAKTIR.

Modal'lar ToucanDialogService üzerinden açılır.

## Governance

Anayasa değişikliği MINOR sürüm artırır.
`;

/**
 * The constitution was written, amended, and read by nobody.
 *
 * Measured on a real project: 543 lines, 13 principles, and its text reached no role's prompt at all —
 * `phases.ts` referenced only its PATH, to tell the analyst where to write it. Three of the defects fixed by
 * hand in one evening — agents chaining shell commands, an agent touching the environment, documentation and
 * code drifting between languages — were already written down in that file.
 */
describe("splitting the constitution into rules", () => {
  const rules = parseConstitution(DOC);

  it("keeps each paragraph as its own rule, under its heading", () => {
    expect(rules.length).toBe(4);
    expect(rules.map((r) => r.section)).toEqual(["I", "VII", "VII", "Governance"]);
  });

  /**
   * By paragraph, not by heading, because a heading is too coarse. Measured: principle IX carries the backend
   * target version, the frontend quality gate AND "commands are atomic — no `cd`, no `&&`, no pipes", which
   * binds every role that has a shell.
   */
  it("splits one heading into the several rules it actually holds", () => {
    expect(rules.filter((r) => r.section === "VII")).toHaveLength(2);
  });

  /** The rationale persuades a person; an agent that has been handed the rule does not need persuading. */
  it("drops the rationale", () => {
    expect(rules.some((r) => /Gerekçe/.test(r.text))).toBe(false);
  });

  it("treats the divider as a divider, not as a rule", () => {
    expect(rules.some((r) => /Core Principles/.test(r.heading))).toBe(false);
  });

  it("says nothing about a project without one", () => {
    expect(parseConstitution("")).toEqual([]);
  });
});

describe("what a piece of work is about", () => {
  it("reads the files it touches", () => {
    expect([...scopesForWork({ files: ["src/app/Order.cs"] })]).toContain("backend");
    expect([...scopesForWork({ files: ["libs/ui/page.html"] })]).toContain("frontend");
    expect([...scopesForWork({ files: ["db/migrations/001.sql"] })]).toContain("data");
    expect([...scopesForWork({ files: ["infra/main.tf"] })]).toContain("infra");
  });

  it("reads the role doing it", () => {
    expect([...scopesForWork({ role: "code-reviewer" })]).toContain("review");
    expect([...scopesForWork({ role: "tester" })]).toContain("test");
    expect([...scopesForWork({ role: "analyst" })]).toContain("spec");
  });

  it("always includes what binds everyone", () => {
    expect([...scopesForWork({})]).toContain("always");
  });
});

const rule = (section: string, scopes: string[], size = 100): ScopedRule =>
  ({ section, heading: section, text: "x".repeat(size), scopes: scopes as ScopedRule["scopes"] });

describe("choosing the rules that bind this work", () => {
  const all = [
    rule("I", ["always"]), rule("VII", ["frontend"]), rule("III", ["backend"]), rule("Gov", ["govern"]),
  ];

  it("gives every role what binds everyone", () => {
    const sel = selectRules(all, scopesForWork({ files: ["a.cs"] }));
    expect(sel.used.map((r) => r.section)).toContain("I");
  });

  it("gives a backend card the backend rules and not the frontend ones", () => {
    const sel = selectRules(all, scopesForWork({ files: ["src/Order.cs"] }));
    const got = sel.used.map((r) => r.section);
    expect(got).toContain("III");
    expect(got).not.toContain("VII");
  });

  /** Amending the constitution binds nobody who is writing code. */
  it("never sends the amendment procedure to a coder", () => {
    const sel = selectRules(all, scopesForWork({ files: ["src/Order.cs"] }));
    expect(sel.used.map((r) => r.section)).not.toContain("Gov");
  });

  /**
   * A MUST that falls off the end silently is worse than no constitution: the document still says it, and
   * everyone believes it is in force.
   */
  it("never drops what binds everyone, however tight the budget", () => {
    const many = [rule("I", ["always"], 500), ...Array.from({ length: 40 }, (_, i) => rule(`S${i}`, ["backend"], 500))];
    const sel = selectRules(many, scopesForWork({ files: ["a.cs"] }), 1_200);
    expect(sel.used.map((r) => r.section)).toContain("I");
    expect(sel.dropped.length).toBeGreaterThan(0);
  });

  it("says out loud what did not fit", () => {
    const many = [rule("I", ["always"], 500), ...Array.from({ length: 10 }, (_, i) => rule(`S${i}`, ["backend"], 500))];
    const sel = selectRules(many, scopesForWork({ files: ["a.cs"] }), 1_200);
    expect(sel.text).toMatch(/did not fit/i);
  });

  it("says the rules are binding, and where the rest of them live", () => {
    const sel = selectRules(all, scopesForWork({}));
    expect(sel.text).toMatch(/binding/i);
    expect(sel.text).toContain(".specify/memory/constitution.md");
  });

  it("says nothing at all when the project has no constitution", () => {
    expect(selectRules([], scopesForWork({})).text).toBe("");
  });

  /**
   * The first guess was 14,000, and the first real labelling walked into it: a backend card selects 15,934
   * characters and a reviewer 16,758, so every backend review would have dropped ~2,700 characters of rules
   * that applied. A ceiling that cannot fit what a normal card needs silently edits the constitution.
   */
  it("fits what a card actually selects, and still refuses the whole document", () => {
    expect(MAX_CONSTITUTION_CHARS).toBeGreaterThan(16_758);   // …a reviewer on a backend card, measured
    expect(MAX_CONSTITUTION_CHARS).toBeLessThan(25_666);      // …the whole document, measured
  });
});

describe("labelling the rules", () => {
  const rules = parseConstitution(DOC);

  it("hands the model every rule, numbered, under its heading", () => {
    const msg = classifyMessage(rules);
    expect(msg).toContain("--- 0 ---");
    expect(msg).toContain("Angular Modern Pattern");
  });

  it("names every scope, and never asks for a rewrite", () => {
    expect(CLASSIFY_PROMPT).toMatch(/Do not translate, summarise or rewrite/i);
    for (const s of SCOPES) expect(CLASSIFY_PROMPT).toContain(s);
  });

  /**
   * An unlabelled MUST must not become an unsent one — but it must not be silent either.
   *
   * The first run of this labelled nothing: seventy rules went out in a single call, the answer came back at
   * half a list, and every rule it never reached defaulted to `always`. On screen that was indistinguishable
   * from a constitution that genuinely binds everyone.
   */
  it("binds everyone with anything it failed to label, and counts it", () => {
    const out = applyLabels(rules, [{ index: 0, scopes: ["backend"] }]);
    expect(out.scoped[0].scopes).toEqual(["backend"]);
    expect(out.scoped[1].scopes).toEqual(["always"]);
    expect(out.unlabelled).toEqual([1, 2, 3]);
  });

  it("ignores a scope it does not know rather than carrying it", () => {
    const out = applyLabels(rules, [{ index: 0, scopes: ["backend", "nonsense"] }]);
    expect(out.scoped[0].scopes).toEqual(["backend"]);
  });

  /** A short answer is a complete answer; four calls once per constitution is not a cost worth protecting. */
  it("asks in batches small enough to be answered in full", async () => {
    const { CLASSIFY_BATCH } = await import("../../src/engine/constitution.js");
    expect(CLASSIFY_BATCH).toBeLessThanOrEqual(25);
    const msg = classifyMessage(rules.slice(1, 3), 1);
    expect(msg).toContain("--- 1 ---");   // …numbered by their place in the whole document
    expect(msg).toContain("--- 2 ---");
  });

  /** `always` stopped being the free answer: a cheap model took it seventy times out of seventy. */
  it("makes `always` a considered answer rather than a safe one", () => {
    expect(CLASSIFY_PROMPT).toMatch(/`always` is a real answer, not a safe one/i);
    expect(CLASSIFY_PROMPT).toMatch(/NOT because you are unsure/i);
    expect(CLASSIFY_PROMPT).toMatch(/sends it to everyone writing CSS/i);
  });
});

/**
 * The rules have to REACH the roles, or the parsing is decoration.
 *
 * The reviewer gets the same set as the implementer of that card on purpose: a gate that does not know what
 * was required cannot tell whether it was met, and that is exactly where a constitution stops being one.
 */
describe("which roles are handed the constitution", () => {
  const src = async (f: string): Promise<string> =>
    (await import("node:fs/promises")).readFile(f, "utf8");

  it("reaches the roles that write, review, specify and verify", async () => {
    for (const [file, role] of [
      ["src/engine/implementer.ts", "the card's own role"],
      ["src/engine/reviewer.ts", '"code-reviewer"'],
      ["src/speckit/phases.ts", "the phase's role"],
      ["src/engine/verify.ts", '"tester"'],
    ] as const) {
      const s = await src(file);
      expect(s, `${file} (${role})`).toContain("constitutionNote(");
      expect(s, file).toMatch(/systemPrompt[^;]*\blaw\b|\+ law/);
    }
  });

  it("gives the reviewer the card's files, so it judges what was actually required", async () => {
    const s = await src("src/engine/reviewer.ts");
    const at = s.indexOf("constitutionNote(");
    expect(s.slice(at, at + 200)).toContain("files: task.files");
  });

  /** Derived, and the project checkout is read and never written — see test/session/root-stays-clean. */
  it("caches the labelling under horse-code's home, not in the project", async () => {
    const s = await src("src/engine/constitution-store.ts");
    expect(s).toContain('join(home, ".horsecode", "constitution"');
    expect(s).toContain("createHash");        // …keyed by the constitution's content
  });

  /**
   * Labelling is the whole mechanism, and it is paid for once per document — so it uses the strongest chain
   * a project configures rather than the role that happens to own the constitution.
   */
  it("labels with the judge, not with whoever writes the document", async () => {
    const s = await src("src/engine/constitution-store.ts");
    expect(s).toContain('deps.roleRegistry.resolve("judge")');
  });

  /** One call per document, not per card: a wave of eight implementers must not pay it eight times. */
  it("labels once and remembers", async () => {
    const s = await src("src/engine/constitution-store.ts");
    expect(s).toContain("const memo = new Map<string, ScopedRule[]>()");
  });

  /**
   * Failure is survivable and must be visible. One batch that will not answer leaves its rules bound to
   * everyone and lets the next batch try; the count of what fell through is said out loud.
   */
  it("keeps going when a batch fails, and says how many rules fell through", async () => {
    const s = await src("src/engine/constitution-store.ts");
    // A failed batch no longer ends the loop OR ends the labelling: it is retried, then counted, and the
    // remaining batches still run. See "noticing a labelling that did not happen" for why counting matters.
    expect(s).toContain("if (attempt === CLASSIFY_RETRIES) failed++;");
    expect(s).toMatch(/could not be labelled/i);
    expect(s).toContain("applyLabels(rules, labels)");
  });
});

/**
 * A labelling that lost calls looks exactly like a document that binds everyone — except in size.
 *
 * Measured live, on the fourth run of the same 70-rule constitution: one classify call of four came back
 * with `finish_reason: null` and zero tokens in and out, so its twenty rules fell through to `always`. With
 * a second batch lost the same way, `always` went from 13 blocks to 35 — half the document sent to every
 * role on every task — and a backend card then selected 20,559 characters against the 20,000 ceiling, so
 * the mechanism began dropping the rules it exists to deliver. The result was cached, which would have made
 * it permanent for that document.
 */
describe("noticing a labelling that did not happen", () => {
  const rules = (n: number, scopes: string[]): ScopedRule[] =>
    Array.from({ length: n }, (_, i) => ({
      section: `${i}`, heading: `H${i}`, text: `rule ${i}`, scopes: scopes as ScopedRule["scopes"],
    }));

  it("accepts the shape three good runs produced", () => {
    // 13-14 of 70 in `always` — measured, three times.
    expect(labellingLooksWrong([...rules(13, ["always"]), ...rules(57, ["backend"])])).toBeUndefined();
  });

  it("rejects the shape the failed run produced", () => {
    const bad = labellingLooksWrong([...rules(35, ["always"]), ...rules(35, ["backend"])]);
    expect(bad).toContain("35 of 70");
  });

  it("says nothing about a project with no constitution", () => {
    expect(labellingLooksWrong([])).toBeUndefined();
  });

  /** The threshold is a share, so it holds for a document of any size. */
  it("scales with the document", () => {
    const share = Math.floor(10 * MAX_ALWAYS_SHARE);
    expect(labellingLooksWrong([...rules(share, ["always"]), ...rules(10 - share, ["backend"])])).toBeUndefined();
    expect(labellingLooksWrong([...rules(share + 1, ["always"]), ...rules(9 - share, ["backend"])])).toBeDefined();
  });
});

/**
 * …and an untrustworthy labelling is not written to the cache.
 *
 * The cache is keyed on the document's content, so a bad answer stored under that key is the answer forever:
 * the run that failed is the run that decides, and no later run asks again. Asserted on the source — the
 * write is one branch of a function whose other branch is several model calls.
 */
describe("what reaches the cache", () => {
  it("skips the write when a batch failed or the result looks wrong", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/engine/constitution-store.ts", "utf8");
    expect(src).toContain("const wrong = labellingLooksWrong(scoped);");
    const guard = src.indexOf("if (failed || wrong) {");
    const write = src.indexOf("writeFileSync(cache");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(write); // the write is in the else branch
  });

  it("retries a batch before letting its rules fall through", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/engine/constitution-store.ts", "utf8");
    expect(src).toContain("for (let attempt = 0; attempt <= CLASSIFY_RETRIES; attempt++)");
    expect(src).toContain("if (attempt === CLASSIFY_RETRIES) failed++;");
  });
});
