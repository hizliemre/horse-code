import { z } from "zod";

/**
 * A card's place in the pipeline.
 *
 * DONE means REVIEWED — the code passed its review and its acceptance gate. MERGED means it is in the base
 * branch, which is a different claim and the only one that means the work was delivered. They were the same
 * column, and a merge that hit a conflict left the card reading DONE with its code nowhere: a real board
 * reported 70 done against ONE merge commit, and a resumed run then skipped all of them as already finished.
 *
 * ABANDONED is the same lesson at the other end. TODO used to mean both "not started yet" and "the run gave
 * up on this", and the second is not waiting for anything: a user watching 21 cards sit in TODO asked why
 * they were not being handed out, when five had exhausted the escalation ladder and sixteen had been skipped
 * because a dependency failed. The scheduler's own queue held two. A count that mixes work with wreckage
 * cannot be read.
 *
 * PARKED is the third lesson, and the sharpest. A task used to be ABANDONED the moment its ladder ran out,
 * as if that were a verdict about the task. Measured over one day on one board: THIRTY tasks were abandoned
 * at some point and TWENTY-NINE of them later passed review, unchanged, simply because something tried them
 * again. A decision that is wrong twenty-nine times out of thirty is not a decision.
 *
 * So a task that cannot go on now is PARKED, with the REASON recorded, and each reason has its own waking
 * condition: waiting on a dependency wakes when that dependency merges; exhausted or conflicted wakes when
 * anything at all merges, because the base has moved and the ground of the last failure is gone.
 *
 * ABANDONED survives for the one case that is a verdict: nothing left that could ever wake it.
 */
export type Column = "TODO" | "IN-PROGRESS" | "REVIEW" | "DONE" | "MERGED" | "PARKED" | "ABANDONED";

/** How much of a card's history is kept. Enough to see the pattern of a struggling task, not unbounded. */
export const MAX_STAGE_EVENTS = 200;

export interface StageEvent {
  role: string;
  action: string;
  note?: string;
}

export interface Card {
  id: string;
  title: string;
  column: Column;
  worktree?: string;
  deps: string[];
  /** Concrete, checkable statements that must hold before this card may enter DONE. */
  acceptance: string[];
  /**
   * The files this task is expected to create or modify, repo-relative.
   *
   * The task list already names them — `writing-plans` requires exact paths per task — but they used to stop
   * at `tasks.md` and never reach the board, so nothing downstream could use them. Two things need them:
   * wave planning (two tasks writing the same file are not independent, whatever their `deps` say) and
   * routing (the extensions say what KIND of work it is far more reliably than the title does).
   *
   * Advisory, not a fence: an implementer that has to touch one more file is not doing anything wrong.
   */
  files: string[];
  reviewNotes: string[];
  attempts: number;
  stageHistory: StageEvent[];
  model?: string; // the model of the implementer currently working this card (for the live-agents UI)
  /** The role of the implementer currently working this card — the agent panel names WHO, not just what. */
  role?: string;
}

export interface BoardData {
  version: 1;
  cards: Card[];
}

const stageEventSchema = z.object({
  role: z.string(),
  action: z.string(),
  note: z.string().optional(),
});
const cardSchema = z.object({
  id: z.string(),
  title: z.string(),
  column: z.enum(["TODO", "IN-PROGRESS", "REVIEW", "DONE", "MERGED", "PARKED", "ABANDONED"]),
  worktree: z.string().optional(),
  deps: z.array(z.string()),
  acceptance: z.array(z.string()).default([]), // default: boards persisted before the gate existed still load
  files: z.array(z.string()).default([]),       // ditto — a board written before file lists existed still loads
  reviewNotes: z.array(z.string()),
  attempts: z.number(),
  stageHistory: z.array(stageEventSchema),
});
const boardDataSchema = z.object({ version: z.literal(1), cards: z.array(cardSchema) });

/**
 * A board written before MERGED existed used DONE to mean DELIVERED.
 *
 * Splitting the two changed what a persisted column MEANS, and an old board says DONE for work that really
 * is in the base branch. Read literally, every one of those cards looks undelivered: a real board came back
 * with 69 DONE, one MERGED, and 24 tasks that could never start because their dependencies were all in that
 * 69 — the whole run collapsed to one task at a time, redoing finished work.
 *
 * The evidence is already on the card. A `merged` stage event is git having said so at the time, so those
 * become MERGED; a DONE card without one was reviewed and never landed, which is exactly what DONE now means
 * and exactly the card that should be retried.
 */
function migrateDelivered(c: Card): Card {
  if (c.column !== "DONE") return c;
  return c.stageHistory.some((e) => e.action === "merged") ? { ...c, column: "MERGED" } : c;
}

function cloneCard(c: Card): Card {
  return {
    ...c,
    deps: [...c.deps],
    acceptance: [...c.acceptance],
    files: [...c.files],
    reviewNotes: [...c.reviewNotes],
    stageHistory: c.stageHistory.map((e) => ({ ...e })),
  };
}

export class Board {
  onChange?: () => void; // called after every mutation (if set; H3a progress events)
  onMove?: (card: Card, from: Column, to: Column, actor?: string) => void; // called on a real column transition → action notes
  private cards = new Map<string, Card>();

  constructor(cards: Card[] = []) {
    for (const c of cards) this.cards.set(c.id, cloneCard(c));
  }

  addCard(input: { id: string; title: string; deps?: string[]; acceptance?: string[]; files?: string[] }): Card {
    if (this.cards.has(input.id)) throw new Error(`card already exists: ${input.id}`);
    const card: Card = {
      id: input.id,
      title: input.title,
      column: "TODO",
      deps: input.deps ? [...input.deps] : [],
      acceptance: input.acceptance ? [...input.acceptance] : [],
      files: input.files ? [...input.files] : [],
      reviewNotes: [],
      attempts: 0,
      stageHistory: [],
    };
    this.cards.set(card.id, card);
    this.onChange?.();
    return cloneCard(card);
  }

  get(id: string): Card | undefined {
    const c = this.cards.get(id);
    return c ? cloneCard(c) : undefined;
  }

  list(): Card[] {
    return [...this.cards.values()].map(cloneCard);
  }

  byColumn(column: Column): Card[] {
    return this.list().filter((c) => c.column === column);
  }

  private require(id: string): Card {
    const c = this.cards.get(id);
    if (!c) throw new Error(`unknown card: ${id}`);
    return c;
  }

  move(id: string, column: Column, actor?: string): void {
    const c = this.require(id);
    const from = c.column;
    c.column = column;
    if (actor) {
      c.stageHistory.push({ role: actor, action: `→${column}` });
      // Bounded: a card that cycles through review a dozen times accumulates events forever, and the board
      // is held in memory AND re-serialised to disk on every mutation. The tail is what anyone reads.
      if (c.stageHistory.length > MAX_STAGE_EVENTS) {
        c.stageHistory.splice(0, c.stageHistory.length - MAX_STAGE_EVENTS);
      }
    }
    if (from !== column) this.onMove?.(c, from, column, actor); // surface the transition as a chat action
    this.onChange?.();
  }

  /**
   * Records a dependency the breakdown missed.
   *
   * Returns false — rather than throwing — for anything that is not a real new edge (unknown id, self, or
   * already present), because the caller is an audit whose input is a model's suggestion: a nonsense entry
   * is an expected outcome there, not an exceptional one.
   */
  addDep(id: string, dependsOn: string): boolean {
    const c = this.cards.get(id);
    if (!c || id === dependsOn || !this.cards.has(dependsOn) || c.deps.includes(dependsOn)) return false;
    c.deps.push(dependsOn);
    this.onChange?.();
    return true;
  }

  /** Undoes `addDep` — used when the added edge turns out to close a cycle. */
  removeDep(id: string, dependsOn: string): void {
    const c = this.cards.get(id);
    if (!c) return;
    c.deps = c.deps.filter((d) => d !== dependsOn);
    this.onChange?.();
  }

  appendStage(id: string, event: StageEvent): void {
    this.require(id).stageHistory.push({ ...event });
    this.onChange?.();
  }

  /** Records the model of the implementer now working this card (surfaced in the live-agents UI). */
  setModel(id: string, model: string): void {
    this.require(id).model = model;
    this.onChange?.();
  }

  /**
   * Returns an interrupted card to TODO and forgets who was working it.
   *
   * Deliberately silent — no stage event, no move note: nothing HAPPENED to this task, a process died. The
   * chat should not report a transition the user did not cause and no agent performed.
   */
  reopen(id: string): void {
    const c = this.require(id);
    c.column = "TODO";
    c.role = undefined;
    c.model = undefined;
    this.onChange?.();
  }

  /** Records WHO is working this card: the role and the model it will actually use. */
  setWorker(id: string, role: string, model: string): void {
    const c = this.require(id);
    c.role = role;
    c.model = model;
    this.onChange?.();
  }

  addReviewNote(id: string, note: string): void {
    this.require(id).reviewNotes.push(note);
    this.onChange?.();
  }

  clearReviewNotes(id: string): void {
    this.require(id).reviewNotes = [];
    this.onChange?.();
  }

  /**
   * Starts the escalation ladder over for one card, keeping its history.
   *
   * The tier is derived from `attempts`, so a task carrying a large count from earlier runs begins at the
   * council — the most expensive tier, and the one that had already failed it. Everything that actually
   * happened stays in `stageHistory`; only the counter that picks the tier goes back to zero.
   */
  resetAttempts(id: string): void {
    const c = this.require(id);
    if (c.attempts === 0) return;
    c.stageHistory.push({ role: "team-lead", action: "reset", note: `new run — ladder restarted (was ${c.attempts})` });
    c.attempts = 0;
    this.onChange?.();
  }

  incrementAttempts(id: string): number {
    const c = this.require(id);
    c.attempts += 1;
    this.onChange?.();
    return c.attempts;
  }

  setWorktree(id: string, path: string): void {
    this.require(id).worktree = path;
    this.onChange?.();
  }

  toJSON(): BoardData {
    return { version: 1, cards: this.list() };
  }

  static fromJSON(data: unknown): Board {
    const parsed = boardDataSchema.parse(data);
    return new Board(parsed.cards.map(migrateDelivered));
  }
}
