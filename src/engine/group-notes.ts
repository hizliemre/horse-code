/**
 * Reviewer notes, grouped by what they are ABOUT before an implementer is asked to address them.
 *
 * A review round produces one note per lens per problem, and the lenses overlap heavily because they are
 * looking at the same code from different angles. Measured on a live board: 26 notes across two returning
 * tasks resolved to 7 subjects, and one method — `UpdateCompanyDetails` — drew SEVEN notes from seven lenses,
 * of which four described the identical defect (a commit followed by an unhandled downstream send).
 *
 * They were handed over as a flat bulleted list, so four views of one defect arrived as four items of work.
 * That invites four partial patches, and a patch that satisfies `code-error-handling` while leaving
 * `code-concurrency` unconvinced comes straight back for another full round of the team — which is the
 * attempt count the board was paying for: 4 attempts on a four-file task, 6 on a nineteen-file one.
 *
 * Nothing is dropped, reworded or ranked here. Every note appears exactly once, verbatim, under the thing it
 * names — the difference is only that an implementer can see it is being told about seven problems rather
 * than twenty-six.
 */

/** How a note is filed: the file it names, else the first type or method it names. */
export function subjectOf(note: string): string | undefined {
  /**
   * A path wins over a symbol, because it is the more specific answer and the one a reviewer actually cites.
   * The extension list is deliberately short — these are the files the lenses quote.
   */
  const path = /\b((?:[\w.-]+\/)+[\w.-]+\.(?:cs|ts|tsx|json|sql|md))\b/.exec(note)?.[1];
  /**
   * The extension goes, so a note citing `UpdateCompanyDetails.cs` files with one naming
   * `UpdateCompanyDetails`. Measured: without this the same method drew two groups of two and five instead
   * of one of seven — the split hid exactly the concentration the grouping exists to show.
   */
  if (path) return path.split("/").pop()!.replace(/\.\w+$/, "");
  // Two or more CamelHumps: `UpdateCompanyDetails`, `FindRegisteredCompanyIdsAsync`. A single capitalised
  // word ("Registration", "Email") is prose, not a subject, and grouping on it merges unrelated notes.
  return /\b([A-Z][a-z]+(?:[A-Z][a-z0-9]+){1,})\b/.exec(note)?.[1];
}

/**
 * The notes, grouped, as the block an implementer is handed.
 *
 * Groups come out in the order their subject was first mentioned, so the reading order of the original list
 * is preserved rather than replaced by a ranking this has no basis to make. A subject with one note is left
 * ungrouped: a heading over a single line is ceremony, and the point is to show where the WEIGHT is.
 */
export function groupNotes(notes: readonly string[]): string {
  const order: string[] = [];
  const bySubject = new Map<string, string[]>();
  const loose: string[] = [];

  for (const note of notes) {
    const s = subjectOf(note);
    if (!s) { loose.push(note); continue; }
    if (!bySubject.has(s)) { bySubject.set(s, []); order.push(s); }
    bySubject.get(s)!.push(note);
  }

  const blocks: string[] = [];
  for (const s of order) {
    const group = bySubject.get(s)!;
    if (group.length === 1) { loose.push(group[0]); continue; }
    /**
     * The count is the message. Seven notes under one name says "this is one thing seen seven ways, fix the
     * thing" far more directly than any instruction wrapped around the list would.
     */
    blocks.push(`${s} — ${group.length} notes, one subject:\n${group.map((n) => `  - ${n}`).join("\n")}`);
  }
  // Singles last: they are genuinely separate work, and putting them first would bury the clusters.
  if (loose.length) blocks.push(loose.map((n) => `- ${n}`).join("\n"));
  return blocks.join("\n\n");
}
