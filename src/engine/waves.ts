import type { Board } from "../board/board.js";

/** Kartları deps'e göre topolojik dalgalara böler. Döngü/çözülemeyen dep → hata. */
export function computeWaves(board: Board): string[][] {
  const cards = board.list();
  const placed = new Set<string>();
  const waves: string[][] = [];
  let remaining = cards;

  while (remaining.length) {
    const layer = remaining.filter((c) => c.deps.every((d) => placed.has(d)));
    if (layer.length === 0) {
      throw new Error("computeWaves: bağımlılık döngüsü veya çözülemeyen bağımlılık");
    }
    waves.push(layer.map((c) => c.id));
    for (const c of layer) placed.add(c.id);
    remaining = remaining.filter((c) => !placed.has(c.id));
  }
  return waves;
}

/** Dalgalar geçerli mi: her kart tam bir kez + her task'ın deps'i önceki dalgalarda. */
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
