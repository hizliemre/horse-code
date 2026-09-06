import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import {
  parseGuide, splitInstructions, renderStep, recordOutcome, progressLine, loadGuide, STATUSES,
  scenarioOutcome, findGuide,
} from "../../src/engine/smoke-test.js";
import type { SmokeStep, SmokeStatus } from "../../src/engine/smoke-test.js";

/** The shape a real run writes — taken from the supplier feature's own quickstart.md. */
const GUIDE = `# Tedarikçi Sistemi Manuel Doğrulama Rehberi

Bu rehber, US1–US5 davranışlarının manuel doğrulamasını kaydeder.

## Ortam ön koşulları

1. Ortamı geliştirici başlatır; bu belge runtime başlatmaz.
2. Alıcı X ve tedarikçi Y olarak iki farklı şirket seçilebilir olmalıdır.

## Manuel senaryolar

### Senaryo 1 — Kayıtlı hedefe talep ve kabul

X'ten Y'ye tedarikçi talebi gönderin, Y'de kabul edin ve iki taraftaki ilişki listesini kontrol edin. Y'de alıcı adını taşıyan tedarikçi kanalını doğrulayın. Sevkiyat modunun kabul sonrasında değiştirilemediğini doğrulayın.

### Senaryo 2 — Red ve sonlandırma

Kayıtlı hedefte red yanıtını doğrulayın. Katılımcı olmayan Z şirketinin ilişkiyi göremediğini kanıtlayın.

## Doğrulama kaydı

Çalışan yerel ortam sağlanmadı.

| Senaryo | Durum | Gözlenen kanıt |
| --- | --- | --- |
| 1 — talep ve kabul | kod üzerinden doğrulandı | \`CreateSupplierRelation\` Submitted üretir. |
| 2 — ilişki yaşam döngüsü | kod üzerinden doğrulandı | \`RespondSupplierRelation\` durum koşullu update kullanır. |
`;

/**
 * The guide writes each scenario as a paragraph of imperatives. A sentence is one thing a person can do and
 * report on; handing over the paragraph at once is what makes a manual pass drift.
 */
describe("turning a scenario into steps", () => {
  it("splits a paragraph into the separate things it asks for", () => {
    const out = splitInstructions("Talebi gönderin, kabul edin ve listeyi kontrol edin. Kanalı doğrulayın.");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("Talebi gönderin");
  });

  it("drops fragments too short to be an instruction", () => {
    expect(splitInstructions("Evet. Talebi gönderin ve sonucu kontrol edin.")).toEqual(
      ["Talebi gönderin ve sonucu kontrol edin."]);
  });
});

describe("reading the guide a run wrote", () => {
  const g = parseGuide("/w/quickstart.md", GUIDE);

  it("takes the title and the preconditions", () => {
    expect(g.title).toContain("Manuel Doğrulama Rehberi");
    expect(g.preconditions).toHaveLength(2);
    expect(g.preconditions[0]).toContain("Ortamı geliştirici başlatır");
  });

  it("numbers every step across the whole guide", () => {
    expect(g.steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5]);
    expect(g.scenarios).toHaveLength(2);
  });

  it("keeps each step with the scenario it came from", () => {
    expect(g.steps[0].scenario).toContain("Senaryo 1");
    expect(g.steps[3].scenario).toContain("Senaryo 2");
    expect(g.steps[3].scenarioIndex).toBe(1);
  });

  /**
   * The record is what this walk WRITES. Stepping a person through a table of past conclusions would ask
   * them to re-verify what is about to be replaced.
   */
  it("does not walk the verification record as if it were work", () => {
    for (const s of g.steps) {
      expect(s.instruction).not.toContain("kod üzerinden doğrulandı");
      expect(s.instruction).not.toContain("|");
    }
  });
});

describe("what a person sees", () => {
  const g = parseGuide("/w/quickstart.md", GUIDE);

  it("says where they are and what to do", () => {
    const text = renderStep(g.steps[0], g.steps.length);
    expect(text).toContain("Adım 1/5");
    expect(text).toContain("Senaryo 1");
    expect(text).toContain("tedarikçi talebi gönderin");
  });

  it("shows progress that reaches both ends", () => {
    expect(progressLine(0, 5)).toContain("0/5");
    expect(progressLine(5, 5)).toContain("5/5");
    expect(progressLine(5, 5)).not.toContain("░");
    expect(progressLine(0, 0)).toContain("0/0");
  });
});

/**
 * The document exists to separate what was SEEN from what was assumed — every row a run writes says
 * "verified from the source". Turning that into a real outcome is the whole point of walking it.
 */
describe("writing the outcome back into the guide", () => {
  it("replaces the assumed status with what was observed", () => {
    const out = recordOutcome(GUIDE, 0, "geçti", "X→Y talebi 201 döndü; Y'de kanal açıldı.");
    expect(out).toContain("| 1 — talep ve kabul | geçti | X→Y talebi 201 döndü; Y'de kanal açıldı. |");
    // The row it was not about is untouched.
    expect(out).toContain("| 2 — ilişki yaşam döngüsü | kod üzerinden doğrulandı |");
  });

  /**
   * Paired on the row's NUMBER, because the table writes "1 — talep ve kabul" while the heading reads
   * "Senaryo 1 — Kayıtlı hedefe talep ve kabul". Matching on text fails on exactly the rows this updates.
   */
  it("finds the row by its number, not by its wording", () => {
    const out = recordOutcome(GUIDE, 1, "başarısız", "Z şirketi ilişkiyi listeleyebildi.");
    expect(out).toContain("| 2 — ilişki yaşam döngüsü | başarısız | Z şirketi ilişkiyi listeleyebildi. |");
  });

  /** A pipe in pasted evidence would silently split the row into new columns. */
  it("escapes a table separator that arrives inside the evidence", () => {
    const out = recordOutcome(GUIDE, 0, "geçti", "psql: id | status\n1 | Accepted");
    const row = out.split("\n").find((l) => l.startsWith("| 1 —"))!;
    // Escaped, so the pasted pipes render as text instead of opening two more columns.
    expect(row).toContain("id \\| status");
    expect(row.match(/(?<!\\)\|/g)).toHaveLength(4);   // the row's four real separators, and no more
  });

  it("only admits the statuses the guide itself defines", () => {
    expect(STATUSES).toEqual(["geçti", "başarısız", "çalıştırılmadı"]);
  });
});

describe("when there is nothing to walk", () => {
  it("says a project with no guide has not finished a feature run", () => {
    const r = loadGuide("/definitely/not/here");
    expect("error" in r && r.error).toContain("No `specs/NNN-…/quickstart.md`");
  });


});

/**
 * The guide's table is per SCENARIO and the walk is per step, so a row cannot be written until its steps are
 * done — written per step, each would overwrite the last and the row would report only the final sentence.
 */
describe("folding a scenario's steps into its row", () => {
  const step = (n: number): SmokeStep => ({ n, scenario: "S", scenarioIndex: 0, instruction: "x" });
  const r = (n: number, status: SmokeStatus, evidence = "") => ({ step: step(n), status, evidence });

  it("passes only when nothing failed", () => {
    expect(scenarioOutcome([r(1, "geçti", "201"), r(2, "geçti", "kanal açıldı")]).status).toBe("geçti");
  });

  /** A scenario whose third check failed did not pass, however many of the others were fine. */
  it("fails the row on a single failed step", () => {
    expect(scenarioOutcome([r(1, "geçti", "a"), r(2, "başarısız", "b"), r(3, "geçti", "c")]).status)
      .toBe("başarısız");
  });

  it("stays unrun when every step was skipped", () => {
    expect(scenarioOutcome([r(1, "çalıştırılmadı"), r(2, "çalıştırılmadı")]).status).toBe("çalıştırılmadı");
  });

  it("keeps each observation against the step it came from", () => {
    const { evidence } = scenarioOutcome([r(1, "geçti", "201 döndü"), r(3, "geçti", "log 1340")]);
    expect(evidence).toBe("1. 201 döndü 3. log 1340");
  });

  /** A row with no observation must say so, rather than sit empty and read as "nothing to report". */
  it("says plainly when nothing was observed", () => {
    expect(scenarioOutcome([r(1, "çalıştırılmadı")]).evidence).toBe("gözlem kaydedilmedi");
  });
});

/**
 * A run's work lives on a session BRANCH until it merges. Measured on the project this was written for: the
 * root's `specs/` held 002, 003 and 004 while the feature just finished, 005, existed only in
 * `.horsecode/worktrees/<session>/base`. Looking in one place reports "no guide" for the run that wrote one.
 */
describe("finding the guide a run wrote", () => {
  it("looks inside the session worktrees, not only the project root", () => {
    const p = `${process.env.HOME}/Desktop/HighBrains/parrot`;
    if (!existsSync(`${p}/.horsecode/worktrees`)) return;
    const found = findGuide(p);
    expect(found).toBeDefined();
    expect(found!.slug).toMatch(/^\d{3}-/);
    expect(existsSync(found!.path)).toBe(true);
    // The one the root cannot see is exactly the one it must find.
    expect(found!.root).not.toBe(p);
  });

  it("says nothing when the project has no guide anywhere", () => {
    expect(findGuide("/definitely/not/here")).toBeUndefined();
  });

  it("loads and parses the one it found", () => {
    const p = `${process.env.HOME}/Desktop/HighBrains/parrot`;
    if (!existsSync(`${p}/.horsecode/worktrees`)) return;
    const g = loadGuide(p);
    expect("error" in g).toBe(false);
    if ("error" in g) return;
    expect(g.scenarios.length).toBeGreaterThanOrEqual(8);
    expect(g.steps.length).toBeGreaterThan(g.scenarios.length);
  });
});
