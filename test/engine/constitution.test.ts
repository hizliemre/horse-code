import { describe, it, expect } from "vitest";
import {
  parseConstitution, scopesForWork, selectRules, applyLabels, classifyMessage,
  CLASSIFY_PROMPT, MAX_CONSTITUTION_CHARS, SCOPES, type ScopedRule,
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

  it("has a budget smaller than a whole constitution and larger than a scope", () => {
    expect(MAX_CONSTITUTION_CHARS).toBeGreaterThan(12_236);   // …a backend card, measured
    expect(MAX_CONSTITUTION_CHARS).toBeLessThan(27_529);      // …the whole document, measured
  });
});

describe("labelling the rules", () => {
  const rules = parseConstitution(DOC);

  it("hands the model every rule, numbered, under its heading", () => {
    const msg = classifyMessage(rules);
    expect(msg).toContain("--- 0 ---");
    expect(msg).toContain("Angular Modern Pattern");
  });

  it("tells it to prefer `always` when unsure, and never to rewrite", () => {
    expect(CLASSIFY_PROMPT).toMatch(/choose\s+`always`/i);
    expect(CLASSIFY_PROMPT).toMatch(/Do not translate, summarise or rewrite/i);
    for (const s of SCOPES) expect(CLASSIFY_PROMPT).toContain(s);
  });

  /** An unlabelled MUST must not become an unsent one. */
  it("binds everyone with anything it failed to label", () => {
    const out = applyLabels(rules, [{ index: 0, scopes: ["backend"] }]);
    expect(out[0].scopes).toEqual(["backend"]);
    expect(out[1].scopes).toEqual(["always"]);
  });

  it("ignores a scope it does not know rather than carrying it", () => {
    const out = applyLabels(rules, [{ index: 0, scopes: ["backend", "nonsense"] }]);
    expect(out[0].scopes).toEqual(["backend"]);
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

  /** One call per document, not per card: a wave of eight implementers must not pay it eight times. */
  it("labels once and remembers", async () => {
    const s = await src("src/engine/constitution-store.ts");
    expect(s).toContain("const memo = new Map<string, ScopedRule[]>()");
  });

  it("falls back to binding everyone when the labelling fails", async () => {
    const s = await src("src/engine/constitution-store.ts");
    expect(s).toContain('scoped = rules.map((r) => ({ ...r, scopes: ["always" as Scope] }))');
    expect(s).toMatch(/could not be labelled/i);   // …and it says so, rather than going quiet
  });
});
