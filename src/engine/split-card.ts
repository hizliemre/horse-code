import { z } from "zod";
import type { Board, Card } from "../board/board.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import { runStructuredRole } from "../agent/structured.js";
import { subjectOf } from "./group-notes.js";

/**
 * Splitting a card that keeps failing, instead of escalating it again.
 *
 * The ladder answers repeated failure by trying a STRONGER model — implementer, then senior, then council.
 * That is the right answer when a task is hard and the wrong one when a task is BROAD, because a stronger
 * model does not shrink the surface a reviewer has to hold.
 *
 * Measured on one card, `[US1] implement the supplier relationship lifecycle`: 4 files declared, 19 review
 * failures, and the failures named TEN distinct subjects — CreateSupplierRelation seven times,
 * UpdateCompanyDetails three, then SupplierRelationConfiguration, DomainExceptions, CompanyUser,
 * PendingSupplierTarget, notification-models, DeliverPendingSupplierTargets, GetSupplierRelations, and twice
 * an unrelated data file the implementer damaged in passing. Each round the review found a new area; fixing
 * one area touched another and opened the next. It exhausted its ladder, was abandoned, and seventeen cards
 * that depended on it were abandoned without ever being attempted.
 *
 * The card was not one task. No number of attempts finishes ten areas one review round at a time.
 */

/** Review failures after which a card is cut up rather than escalated again — see `reviewFailures`. */
export const SPLIT_AFTER_ATTEMPTS = 5;

/** How many pieces a split may produce. Fewer than two is not a split; more than four is a new breakdown. */
export const MIN_PIECES = 2;
export const MAX_PIECES = 4;

/**
 * The distinct areas a card's review failures have named — breadth, in the only form the board records it.
 *
 * Read from `reviewed:fail` notes rather than from the card's declared `files`, because the declaration is
 * what the planner GUESSED and the failures are what the work actually touched. The card above declared four
 * files and its failures named ten subjects; the declaration is the number that looked fine.
 */
export function failureSubjects(card: Card): string[] {
  const seen: string[] = [];
  for (const h of card.stageHistory) {
    if (h.action !== "reviewed:fail") continue;
    const s = subjectOf(String(h.note ?? ""));
    if (s && !seen.includes(s)) seen.push(s);
  }
  return seen;
}

/**
 * Whether this card should be cut up instead of tried again.
 *
 * The count is the whole rule. A narrower test — "only split when the failures are broad" — was tempting and
 * is left out: a card that has failed five times on ONE subject is not helped by splitting, but it is not
 * helped by a sixth attempt either, and the splitter answers that case honestly by finding nothing to cut
 * and leaving the card alone.
 */
export function shouldSplit(card: Card, after = SPLIT_AFTER_ATTEMPTS): boolean {
  return !wasSplit(card) && reviewFailures(card) >= after;
}

/**
 * Has this card already been replaced by pieces?
 *
 * A split is not idempotent by nature and the board makes that dangerous: the parent is retired, but
 * `exhausted` parking wakes on any merge, and the very first thing that merges after a split is one of its
 * own pieces. Its failure count never falls, so the second scheduling split it again.
 *
 * Observed live: T004 carries TWO `split:into` events. Its first pair delivered the work and merged; its
 * second pair was re-implementing the same feature from scratch behind them.
 */
export function wasSplit(card: Card): boolean {
  return card.stageHistory.some((h) => h.action === "split:into");
}

/**
 * How many times this card has failed review — over its LIFE, not over this run.
 *
 * `attempts` is deliberately reset at the start of every run, so a task that has failed a lot comes back
 * with a fresh ladder rather than born exhausted. That is right for choosing a tier and wrong for choosing
 * to split: the card that ended a run had failed nineteen times across four runs and would have come back
 * reading zero, needing five more failures before anyone noticed it was too big.
 *
 * The lifetime count is safe here in a way it would not be for a gate, and the difference is worth naming:
 * a gate on lifetime history becomes permanent — `noChangeStreak` records exactly that bug — whereas a split
 * happens once and retires the card that carried the history. The pieces start at zero.
 */
export function reviewFailures(card: Card): number {
  return card.stageHistory.filter((h) => h.action === "reviewed:fail").length;
}

export const PiecesSchema = z.object({
  pieces: z.array(z.object({
    title: z.string().describe("What this piece delivers, in the same voice as the original card's title."),
    acceptance: z.array(z.string()).default([]).describe(
      "What must be OBSERVABLY true when this piece is done — checkable against the worktree."),
    files: z.array(z.string()).default([]).describe(
      "Repo-relative files this piece creates or modifies. Two pieces that write the same file are not "
      + "independent, so say so honestly rather than spreading one file across several."),
  })),
});
export type Piece = z.infer<typeof PiecesSchema>["pieces"][number];

/** The brief: the card, what it must still deliver, and the areas its failures have already exposed. */
export function splitRequest(card: Card): string {
  const subjects = failureSubjects(card);
  const notes = card.reviewNotes.slice(0, 12).map((n) => `- ${n}`).join("\n");
  return (
    // `attempts` is reset each run; the lifetime count is the number that means anything to a reader.
    `This task has failed review ${reviewFailures(card)} times and is being CUT UP rather than attempted again.\n\n`
    + `Task: ${card.title}\n`
    + (card.acceptance.length ? `\nIt must still deliver:\n${card.acceptance.map((a) => `- ${a}`).join("\n")}\n` : "")
    + (subjects.length ? `\nIts review failures have named these areas, which is the evidence of where the seams are:\n`
      + `${subjects.map((s) => `- ${s}`).join("\n")}\n` : "")
    + (notes ? `\nThe findings still open:\n${notes}\n` : "")
    + `\nCut it into ${MIN_PIECES}-${MAX_PIECES} pieces that together deliver exactly what the original did — no more, `
    + `no less. Cut along the seams above: a second concern, a second layer, a second story. Each piece must be `
    + `something one reviewer can judge whole, and must leave the repository different on its own. Do not `
    + `invent work the original did not ask for, and do not leave any of its acceptance criteria unclaimed.\n`
    + `Return {pieces} via submit.`
  );
}

/** Asks the role to cut the card. Fewer than two pieces means it found nothing to cut — see `applySplit`. */
export async function proposeSplit(opts: RoleAgentOptions, card: Card): Promise<Piece[]> {
  const { pieces } = await runStructuredRole(
    { ...opts, messages: [...opts.messages, { role: "user", content: splitRequest(card) }] },
    PiecesSchema,
  );
  return pieces.slice(0, MAX_PIECES);
}

/**
 * Replaces a card with its pieces, and moves everything that waited on it onto the last piece.
 *
 * The pieces are CHAINED rather than run in parallel. They came out of one card, so they are the likeliest
 * set on the board to write the same file, and being wrong about that does not fail loudly — it surfaces
 * hours later as a merge conflict. A stuck card is not the place to gamble on parallelism.
 *
 * A dependent waited for the whole of the original, so it waits for the last piece, which transitively waits
 * for the rest. Nothing that depended on the parent is left pointing at a card that no longer runs.
 */
export function applySplit(board: Board, parentId: string, pieces: readonly Piece[]): string[] {
  if (pieces.length < MIN_PIECES) return [];
  const parent = board.get(parentId);
  if (!parent) return [];

  const ids: string[] = [];
  let previous: string | undefined;
  for (const [i, piece] of pieces.entries()) {
    const id = freeId(board, parentId, i);
    board.addCard({
      id,
      title: piece.title,
      // The first piece inherits what the parent waited for; each later one waits for the piece before it.
      deps: previous ? [previous] : [...parent.deps],
      acceptance: piece.acceptance,
      files: piece.files,
    });
    board.appendStage(id, { role: "team-lead", action: "split:from", note: `${parentId} — ${parent.title}` });
    ids.push(id);
    previous = id;
  }

  const last = ids[ids.length - 1];
  for (const c of board.list()) {
    if (c.id === parentId || ids.includes(c.id) || !c.deps.includes(parentId)) continue;
    board.removeDep(c.id, parentId);
    board.addDep(c.id, last);
  }

  board.appendStage(parentId, {
    role: "team-lead", action: "split:into",
    // The LIFETIME count, for the same reason the brief uses it: `attempts` is reset each run, so the record
    // of why this card was cut would have read "0 attempts" on the very run that cut it. It did.
    note: `${reviewFailures(parent)} review failures over ${failureSubjects(parent).length} areas → ${ids.join(", ")}`,
  });
  board.move(parentId, "ABANDONED", "team-lead");
  return ids;
}

/** `T004` → `T004a`, `T004b`… skipping anything the board already holds. */
function freeId(board: Board, parentId: string, index: number): string {
  for (let n = index; n < index + 26; n++) {
    const id = `${parentId}${String.fromCharCode(97 + n)}`;
    if (!board.get(id)) return id;
  }
  return `${parentId}-${index}`;
}

/**
 * A card a PERSON retired, which a run must not quietly pick up again.
 *
 * Abandonment by exhaustion is deliberately reversible: measured over one day on one board, thirty tasks
 * were abandoned and twenty-nine later passed review unchanged, so a new run gives them all another go. A
 * human abandonment is the opposite kind of statement — it is a decision about the work, not a report about
 * the ladder — and reviving it silently undoes the one thing manual intervention is for.
 *
 * Observed: two cards retired by hand as duplicates of already-merged work were back IN-PROGRESS one minute
 * into the next run, re-implementing what had merged.
 */
export function humanAbandoned(card: Card): boolean {
  return card.column === "ABANDONED" && card.stageHistory.some((h) => h.action === "human:abandon");
}
