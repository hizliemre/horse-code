import { z } from "zod";

export type Column = "TODO" | "IN-PROGRESS" | "REVIEW" | "DONE";

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
  column: z.enum(["TODO", "IN-PROGRESS", "REVIEW", "DONE"]),
  worktree: z.string().optional(),
  deps: z.array(z.string()),
  acceptance: z.array(z.string()).default([]), // default: boards persisted before the gate existed still load
  files: z.array(z.string()).default([]),       // ditto — a board written before file lists existed still loads
  reviewNotes: z.array(z.string()),
  attempts: z.number(),
  stageHistory: z.array(stageEventSchema),
});
const boardDataSchema = z.object({ version: z.literal(1), cards: z.array(cardSchema) });

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
  onMove?: (card: Card, from: Column, to: Column) => void; // called on a real column transition → action notes
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
    if (from !== column) this.onMove?.(c, from, column); // surface the transition as a chat action
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

  addReviewNote(id: string, note: string): void {
    this.require(id).reviewNotes.push(note);
    this.onChange?.();
  }

  clearReviewNotes(id: string): void {
    this.require(id).reviewNotes = [];
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
    return new Board(parsed.cards);
  }
}
