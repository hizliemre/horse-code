import type { Board } from "../board/board.js";

/** Splits cards into topological waves based on deps. Cycle/unresolvable dep → error. */
export function computeWaves(board: Board): string[][] {
  const cards = board.list();
  const placed = new Set<string>();
  const waves: string[][] = [];
  let remaining = cards;

  while (remaining.length) {
    const layer = remaining.filter((c) => c.deps.every((d) => placed.has(d)));
    if (layer.length === 0) {
      throw new Error("computeWaves: dependency cycle or unresolved dependency");
    }
    waves.push(layer.map((c) => c.id));
    for (const c of layer) placed.add(c.id);
    remaining = remaining.filter((c) => !placed.has(c.id));
  }
  return waves;
}

/** Are the waves valid: each card exactly once + each task's deps in earlier waves. */
export function validateWaves(waves: string[][], board: Board): boolean {
  const cards = board.list();
  const allIds = new Set(cards.map((c) => c.id));
  const depsOf = new Map(cards.map((c) => [c.id, c.deps]));

  const flat = waves.flat();
  if (flat.length !== allIds.size) return false;
  const seen = new Set<string>();
  for (const id of flat) {
    if (!allIds.has(id) || seen.has(id)) return false;
    seen.add(id);
  }

  const before = new Set<string>();
  for (const wave of waves) {
    for (const id of wave) {
      const deps = depsOf.get(id) ?? [];
      if (!deps.every((d) => before.has(d))) return false;
    }
    for (const id of wave) before.add(id);
  }
  return true;
}

/**
 * Two tasks in the same wave that write the same file.
 *
 * `deps` is the project-manager's account of what depends on what, and nothing checks it. A dependency it
 * FAILS to state does not produce an error — it produces two agents editing one file in separate worktrees
 * and a merge conflict hours later, resolved by a council call that only exists because the plan was wrong.
 * The task's own file list catches that case for free, before anything runs.
 */
export interface FileClash {
  a: string;
  b: string;
  files: string[];
}

/**
 * Compared case-insensitively and with a leading `./` stripped.
 *
 * Deliberately generous: over-reporting costs a little parallelism, under-reporting costs a merge conflict
 * and a council. Two spellings of the same path on a case-insensitive filesystem are the same file.
 */
function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/** Every pair of the given tasks that writes a file in common. */
export function fileClashes(ids: string[], board: Board): FileClash[] {
  const files = new Map<string, Set<string>>();
  for (const id of ids) {
    const card = board.get(id);
    if (card) files.set(id, new Set(card.files.map(normalizePath).filter(Boolean)));
  }
  const out: FileClash[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = files.get(ids[i]), b = files.get(ids[j]);
      if (!a || !b) continue;
      const shared = [...a].filter((f) => b.has(f));
      if (shared.length) out.push({ a: ids[i], b: ids[j], files: shared });
    }
  }
  return out;
}

/**
 * Splits any wave whose tasks would write the same file, so they run in sequence instead of racing.
 *
 * Safe with respect to `deps` by construction: a task only ever moves to a LATER wave, and every dependency
 * it has was already satisfied in an earlier one. First-fit — each task joins the earliest sub-wave it does
 * not clash with — so a single clashing pair costs one extra wave, not a serial chain.
 *
 * A task with no file list is never split out: an empty list means "unknown", and guessing a conflict from
 * silence would serialize a whole board that simply did not fill the field in.
 */
export function splitFileConflicts(waves: string[][], board: Board): { waves: string[][]; clashes: FileClash[] } {
  const clashes: FileClash[] = [];
  const out: string[][] = [];
  for (const wave of waves) {
    const found = fileClashes(wave, board);
    clashes.push(...found);
    if (found.length === 0) { out.push(wave); continue; }
    const bins: { ids: string[]; files: Set<string> }[] = [];
    for (const id of wave) {
      const own = new Set((board.get(id)?.files ?? []).map(normalizePath).filter(Boolean));
      const bin = bins.find((b) => ![...own].some((f) => b.files.has(f)));
      if (bin) { bin.ids.push(id); for (const f of own) bin.files.add(f); }
      else bins.push({ ids: [id], files: own });
    }
    out.push(...bins.map((b) => b.ids));
  }
  return { waves: out, clashes };
}

/**
 * How much of the board actually ran in parallel, and what got in the way.
 *
 * Nothing measured this. A plan that serializes twenty independent tasks and a plan that runs them in three
 * waves produce the same report — "completed" — while costing wildly different amounts of wall-clock, and
 * there was no number anywhere that told the difference.
 */
export interface WaveStats {
  tasks: number;
  waves: number;
  /** Tasks per wave — 1.0 means nothing ran in parallel at all. */
  width: number;
  /** The largest wave: the peak number of implementers running at once. */
  widest: number;
  /** Tasks whose file lists forced them apart — a dependency the plan did not state. */
  clashes: number;
  /** Merge conflicts, failed tasks, skipped tasks, and escalations, counted from the board's own history. */
  conflicts: number;
  failed: number;
  skipped: number;
  escalated: number;
  /** Total implementation attempts across every task; > tasks means work was redone. */
  attempts: number;
}

export function waveStats(board: Board, waves: string[][], clashes: FileClash[] = []): WaveStats {
  const cards = board.list();
  const count = (action: string): number =>
    cards.filter((c) => c.stageHistory.some((e) => e.action === action)).length;
  return {
    tasks: cards.length,
    waves: waves.length,
    width: waves.length ? Number((cards.length / waves.length).toFixed(1)) : 0,
    widest: waves.reduce((n, w) => Math.max(n, w.length), 0),
    clashes: clashes.length,
    conflicts: count("merge-conflict"),
    failed: count("task-failed"),
    skipped: count("skipped"),
    // A task that reached a senior/council tier cost several times what a first-pass task did.
    escalated: cards.filter((c) => c.attempts > 1).length,
    attempts: cards.reduce((n, c) => n + c.attempts, 0),
  };
}

/** One line for the run report — the numbers that say whether the plan was any good. */
export function describeWaves(s: WaveStats): string {
  const parts = [
    `${s.tasks} task in ${s.waves} wave(s) — ${s.width} per wave, widest ${s.widest}`,
    s.clashes ? `${s.clashes} file clash(es) split apart` : "",
    s.conflicts ? `${s.conflicts} merge conflict(s)` : "",
    s.escalated ? `${s.escalated} task(s) took more than one attempt (${s.attempts} total)` : "",
    s.failed ? `${s.failed} failed` : "",
    s.skipped ? `${s.skipped} skipped` : "",
  ];
  return parts.filter(Boolean).join(" · ");
}
