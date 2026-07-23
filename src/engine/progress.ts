import type { Board, Column } from "../board/board.js";

export interface BoardCardView {
  id: string;
  title: string;
  column: Column;
  model?: string; // implementer model while the card is IN-PROGRESS (live-agents UI)
}

export type ProgressEvent =
  | { kind: "phase"; phase: string; detail?: string }
  | { kind: "board"; cards: BoardCardView[] }
  | { kind: "refined"; refinedPrompt: string }
  // Ad-hoc live sub-agents not backed by a board card (e.g. the review council running in parallel).
  // An empty list clears the panel.
  | { kind: "agents"; agents: { id: string; title: string; model: string }[] };

/** Instant card view of the board (id/title/column/model). */
export function snapshotBoard(board: Board): BoardCardView[] {
  return board.list().map((c) => ({ id: c.id, title: c.title, column: c.column, model: c.model }));
}
