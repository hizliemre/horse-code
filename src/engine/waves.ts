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
