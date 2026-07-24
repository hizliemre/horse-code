import { z } from "zod";

export type Column = "TODO" | "IN-PROGRESS" | "REVIEW" | "DONE";

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
  reviewNotes: z.array(z.string()),
  attempts: z.number(),
  stageHistory: z.array(stageEventSchema),
});
const boardDataSchema = z.object({ version: z.literal(1), cards: z.array(cardSchema) });

function cloneCard(c: Card): Card {
  return {
    ...c,
    deps: [...c.deps],
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

  addCard(input: { id: string; title: string; deps?: string[] }): Card {
    if (this.cards.has(input.id)) throw new Error(`card already exists: ${input.id}`);
    const card: Card = {
      id: input.id,
      title: input.title,
      column: "TODO",
      deps: input.deps ? [...input.deps] : [],
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
    if (actor) c.stageHistory.push({ role: actor, action: `→${column}` });
    if (from !== column) this.onMove?.(c, from, column); // surface the transition as a chat action
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
