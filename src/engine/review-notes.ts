import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The durable record of every review finding that was deliberately NOT blocking. */
export const REVIEW_NOTES_FILE = "review-notes.md";

const HEADER =
  "# Deferred review notes\n\n" +
  "Medium/low findings the review deliberately did not block on. They are carried to the next stage as " +
  "context (spec → plan → tasks) and, for code findings, adjudicated in the PR revision pass. This file is " +
  "the durable record so nothing is silently lost — prompt context alone is not a guarantee.\n";

/**
 * Appends deferred findings to `<featureDir>/review-notes.md`, creating it with a header on first write.
 * Best-effort: a failed note write must never break the pipeline. Returns true if anything was written.
 */
export function appendReviewNotes(featureDir: string, notes: string[]): boolean {
  if (!notes.length) return false;
  try {
    const file = join(featureDir, REVIEW_NOTES_FILE);
    if (!existsSync(file)) writeFileSync(file, HEADER, "utf8");
    appendFileSync(file, `\n${notes.map((n) => `- ${n}`).join("\n")}\n`, "utf8");
    return true;
  } catch {
    return false; // the notes still travel in-memory to the next stage; the file is a convenience record
  }
}
