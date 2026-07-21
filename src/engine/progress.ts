import type { Board, Column } from "../board/board.js";

export interface BoardCardView {
  id: string;
  title: string;
  column: Column;
}

export type ProgressEvent =
  | { kind: "phase"; phase: string; detail?: string }
  | { kind: "board"; cards: BoardCardView[] };

/** Board'un anlık kart görünümü (id/title/column). */
export function snapshotBoard(board: Board): BoardCardView[] {
  return board.list().map((c) => ({ id: c.id, title: c.title, column: c.column }));
}
