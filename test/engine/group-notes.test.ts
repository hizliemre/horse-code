import { describe, it, expect } from "vitest";
import { groupNotes, subjectOf } from "../../src/engine/group-notes.js";

/**
 * Verbatim from a live board's `reviewNotes`, trimmed only in length. Seven lenses, one method, and four of
 * the seven describing the identical defect: a commit followed by an unhandled downstream send.
 */
const REAL = [
  "[medium] code-plan-conformance: src/features/Companies/UpdateCompanyDetails.cs:154-158 — the profile-update trigger sends DeliverPendingSupplierTargets",
  "[critical] code-security: Unverified tax number is used as a delivery key, and `UpdateCompanyDetails.CommandHandler` accepts it",
  "[critical] code-error-handling: UpdateCompanyDetails saves the new tax number before invoking delivery, but does not handle delivery failure",
  "[critical] code-concurrency: UpdateCompanyDetails commits the new tax number before sending DeliverPendingSupplierTargets. If delivery fails the target is stranded",
  "[critical] code-correctness: Email delivery is ambiguous for users linked to multiple companies. `FindRegisteredCompanyIdsAsync` selects every match",
  "[medium] code-performance: `FindRegisteredCompanyIdsAsync` loads every company ID and tax number into application memory",
  "[medium] code-maintainability: the 'ux_supplier_relations_active_pair' index name is duplicated as a bare string literal",
];

describe("what a note is about", () => {
  /**
   * The extension goes, so a note citing the FILE files with one naming the TYPE. Without it the same method
   * drew two groups — of two and of five — instead of one of seven, hiding the concentration entirely.
   */
  it("files a note under the file it cites, without its extension", () => {
    expect(subjectOf(REAL[0])).toBe("UpdateCompanyDetails");
  });

  it("falls back to the type or method it names", () => {
    expect(subjectOf(REAL[2])).toBe("UpdateCompanyDetails");
    expect(subjectOf(REAL[5])).toBe("FindRegisteredCompanyIdsAsync");
  });

  /** One capitalised word is prose. Grouping on it merges notes that have nothing to do with each other. */
  it("does not treat an ordinary capitalised word as a subject", () => {
    expect(subjectOf("[medium] code-tests: Registration status is not covered")).toBeUndefined();
    expect(subjectOf("[medium] code-observability: Delivery failures have no log")).toBeUndefined();
  });
});

/**
 * The defect this exists for: a flat list of 19 bullets, seven of them about one method, read as nineteen
 * separate pieces of work. Four partial patches satisfy four lenses and leave the fifth unconvinced, so the
 * task returns for another full round of the team — which is the attempt count the board was paying for.
 */
describe("handing a returning task its notes", () => {
  const out = groupNotes(REAL);

  it("puts every note about one subject together, and says how many", () => {
    // Four, not three: the note citing the .cs file belongs with the three naming the type.
    expect(out).toContain("UpdateCompanyDetails — 4 notes, one subject:");
    expect(out).toContain("FindRegisteredCompanyIdsAsync — 2 notes, one subject:");
  });

  it("loses nothing — every note survives exactly once", () => {
    for (const n of REAL) expect(out.split(n).length - 1).toBe(1);
  });

  /** A heading over a single line is ceremony; the point is to show where the weight is. */
  it("leaves a lone note ungrouped", () => {
    expect(out).toContain("- [medium] code-maintainability:");
  });

  it("keeps the clusters ahead of the singles", () => {
    expect(out.indexOf("UpdateCompanyDetails — 4 notes")).toBeLessThan(out.indexOf("code-maintainability"));
  });

  it("is unchanged by having nothing to group", () => {
    const one = ["[medium] code-tests: something entirely on its own"];
    expect(groupNotes(one)).toBe(`- ${one[0]}`);
    expect(groupNotes([])).toBe("");
  });
});
