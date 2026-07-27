import type { Board, Column } from "../board/board.js";

export interface BoardCardView {
  id: string;
  title: string;
  column: Column;
  model?: string; // implementer model while the card is IN-PROGRESS (live-agents UI)
  role?: string;  // implementer ROLE — the agent panel names who is doing the work, not only what
}

export type ProgressEvent =
  | { kind: "phase"; phase: string; detail?: string }
  | { kind: "board"; cards: BoardCardView[] }
  | { kind: "refined"; refinedPrompt: string }
  // Ad-hoc live sub-agents not backed by a board card (e.g. the review council running in parallel).
  // An empty list clears the panel.
  | { kind: "agents"; agents: { id: string; title: string; model: string }[] }
  // The model actually SERVING a live sub-agent. A row used to show the chain HEAD forever, so once an agent
  // slid down its fallback chain the panel kept naming a model that was no longer doing the work.
  | { kind: "agent-model"; id: string; model: string }
  // A live sub-agent's token spend SO FAR → its row updates while it works, like the main shimmer. Without
  // this a row shows only a ticking clock for minutes, with no signal about what it is costing.
  | { kind: "agent-usage"; id: string; promptTokens: number; completionTokens: number }
  // One live sub-agent finished → stamp its result + token spend on its row (id matches an `agents` entry).
  | { kind: "agent-result"; id: string; status: string; promptTokens?: number; completionTokens?: number }
  // A transcript note pushed live from deep in the pipeline (e.g. each councilor's finding, the judge's call).
  | { kind: "note"; text: string };

/** Instant card view of the board (id/title/column/model). */
export function snapshotBoard(board: Board): BoardCardView[] {
  return board.list().map((c) => ({ id: c.id, title: c.title, column: c.column, model: c.model, role: c.role }));
}
