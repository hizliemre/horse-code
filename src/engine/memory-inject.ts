import {
  selectMemoriesDetailed, renderMemoryHints, memoryReferenced,
  type MemoryEntry, type SelectedMemory, type SelectionStats,
} from "./memory-retrieval.js";
import type { TaskCycleDeps } from "./task-types.js";

/**
 * What memory did, as it happens. Injection used to be entirely invisible: there was no way to tell "no memory
 * applied" from "memory is broken", and no way to see whether an injected hint was ever actually used.
 */
export type MemoryEvent =
  | { kind: "injected"; role: string; hits: SelectedMemory[]; stats: SelectionStats }
  | { kind: "used"; role: string; texts: string[] }
  | { kind: "hygiene"; merged: number; candidates: number }
  | { kind: "learned"; texts: string[] }
  | { kind: "curated"; proposed: number; stored: string[] };

export interface MemoryHints {
  /** Ready-to-append user message, or "" when nothing was selected. */
  message: string;
  /** Ids of the selected memories → the caller reinforces the ones the model actually used. */
  ids: string[];
  hits: SelectedMemory[];
  stats: SelectionStats;
}

const EMPTY_STATS: SelectionStats = { considered: 0, belowThreshold: 0, cooldown: 0, audience: 0, inactive: 0, budget: 0 };

/**
 * Relevant cross-session memory for ANY role, not just the coach.
 *
 * Rules ride every system prompt already (RoleRegistry.ruleSuffix). Facts and lessons did not: the analyst,
 * planner, implementers and reviewers had no access to what earlier runs learned, so they repeated the same
 * mistakes. `role` is both the audience key (a lesson addressed to one lens is not billed to the other fourteen)
 * and the label on the emitted event.
 *
 * `silent` suppresses the event for callers that fan out over many roles at once and report one aggregate
 * instead — fifteen separate notes per review round would bury the chat rather than inform it.
 */
export function memoryHints(
  deps: TaskCycleDeps,
  query: string,
  opts: { load?: number; role?: string; silent?: boolean } = {},
): MemoryHints {
  const all: MemoryEntry[] = deps.memory?.() ?? [];
  // Rules are injected globally; selecting them here would duplicate them in every prompt.
  const selectable = all.filter((m) => (m.kind ?? "fact") !== "rule");
  if (!selectable.length) return { message: "", ids: [], hits: [], stats: { ...EMPTY_STATS } };
  const { hits, stats } = selectMemoriesDetailed(selectable, query, {
    load: opts.load ?? 0,
    ...(opts.role ? { role: opts.role } : {}),
    ...(deps.injectionLog ? { log: deps.injectionLog } : {}),
  });
  if (!hits.length) return { message: "", ids: [], hits, stats };
  const ids = hits.map((h) => h.entry.id);
  deps.injectionLog?.record(ids, Date.now()); // don't re-send these on the next turn
  deps.recordInjection?.(ids); // durable count → "injected ten times, never cited" becomes visible
  if (!opts.silent) deps.onMemory?.({ kind: "injected", role: opts.role ?? "coach", hits, stats });
  return { message: renderMemoryHints(hits.map((h) => h.entry)), ids, hits, stats };
}

/** Sums per-role selections into one event — used by fan-outs (a review team, the council) to report once. */
export function emitBatchInjection(deps: TaskCycleDeps, role: string, parts: MemoryHints[]): void {
  const hits = parts.flatMap((p) => p.hits);
  if (!hits.length) return;
  const stats = parts.reduce<SelectionStats>((acc, p) => ({
    considered: Math.max(acc.considered, p.stats.considered), // the same pool seen N times, not N pools
    belowThreshold: acc.belowThreshold + p.stats.belowThreshold,
    cooldown: acc.cooldown + p.stats.cooldown,
    audience: acc.audience + p.stats.audience,
    inactive: acc.inactive + p.stats.inactive,
    budget: acc.budget + p.stats.budget,
  }), { ...EMPTY_STATS });
  deps.onMemory?.({ kind: "injected", role, hits, stats });
}

/**
 * Credits the memories an IMPLEMENTER used, by the files it touched.
 *
 * An implementer does not cite; it writes code. Judging it by whether its prose repeats a memory's words is
 * judging the wrong artefact, and `reinforceUsed` — which does exactly that — was never called from the
 * implementer at all. So the only usage anyone recorded came from the coach's chat replies.
 *
 * Measured on a real board: memories were injected 262 times and 14 uses were recorded, all from the coach.
 * One lesson — "the filter/sort logic already exists in repository.ts; wire it, do not reimplement it" — was
 * injected THIRTEEN times, recorded zero uses, and the task it was for failed with the reviewer writing "the
 * diff adds a second, unused filter/sort implementation". The memory was right, present, and invisible.
 *
 * A file anchor is the honest signal here: a memory about `repository.ts` was used if the implementer went
 * to `repository.ts`.
 */
export function reinforceTouched(deps: TaskCycleDeps, ids: string[], paths: string[], role: string): void {
  if (!ids.length || !paths.length) return;
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const touched = new Set(paths.map(norm));
  const all = deps.memory?.() ?? [];
  const used = ids
    .map((id) => all.find((m) => m.id === id))
    .filter((e): e is MemoryEntry => !!e && e.anchors.some((a) => {
      const an = norm(a);
      return [...touched].some((t) => t === an || t.endsWith(`/${an}`) || an.endsWith(`/${t}`));
    }));
  if (!used.length) return;
  if (deps.reinforceMemory) for (const e of used) deps.reinforceMemory(e.id);
  deps.onMemory?.({ kind: "used", role, texts: used.map((e) => e.text) });
}

/** Credits the memories the model actually referenced in its output (feeds retrieval ranking). */
export function reinforceUsed(deps: TaskCycleDeps, ids: string[], output: string, role = "coach"): void {
  if (!ids.length) return;
  const all = deps.memory?.() ?? [];
  const used = ids
    .map((id) => all.find((m) => m.id === id))
    .filter((e): e is MemoryEntry => !!e && memoryReferenced(e, output));
  if (!used.length) return;
  if (deps.reinforceMemory) for (const e of used) deps.reinforceMemory(e.id);
  deps.onMemory?.({ kind: "used", role, texts: used.map((e) => e.text) });
}

const clip = (s: string, n = 64): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/** One compact chat line per memory event — enough to see memory working without burying the transcript. */
export function memoryNote(ev: MemoryEvent): string | undefined {
  if (ev.kind === "injected") {
    if (!ev.hits.length) return undefined;
    // The rejection breakdown is the point: "nothing was injected" and "everything was on cooldown" look
    // identical from the outside, and only one of them is a problem.
    const why: string[] = [];
    if (ev.stats.cooldown) why.push(`${ev.stats.cooldown} on cooldown`);
    if (ev.stats.audience) why.push(`${ev.stats.audience} for other roles`);
    if (ev.stats.inactive) why.push(`${ev.stats.inactive} inactive`);
    if (ev.stats.budget) why.push(`${ev.stats.budget} over budget`);
    const skipped = why.length ? ` _(${ev.stats.considered} known — ${why.join(", ")})_` : "";
    const list = ev.hits
      .map((h) => `${h.via === "graph" ? "🔗 " : ""}${h.entry.kind === "lesson" ? "lesson" : "fact"}: "${clip(h.entry.text)}"`)
      .join(" · ");
    return `🧠 **memory** → \`${ev.role}\`: ${ev.hits.length} hint(s)${skipped}\n${list}`;
  }
  if (ev.kind === "used") return `🧠 **memory paid off** in \`${ev.role}\`: ${ev.texts.map((t) => `"${clip(t)}"`).join(" · ")}`;
  if (ev.kind === "learned") return `🧠 **learned** ${ev.texts.length} memory(ies):\n${ev.texts.map((t) => `- ${clip(t, 96)}`).join("\n")}`;
  if (ev.kind === "curated") {
    // The RATIO is the story: review agents propose freely, and most proposals correctly die here.
    const from = ev.proposed ? ` from ${ev.proposed} agent proposal(s)` : "";
    if (!ev.stored.length) return `🧠 **memory curator** — nothing durable to store${from}.`;
    return `🧠 **memory curator** — stored ${ev.stored.length}${from}:\n${ev.stored.map((t) => `- ${clip(t, 96)}`).join("\n")}`;
  }
  const parts: string[] = [];
  if (ev.merged) parts.push(`merged ${ev.merged} duplicate(s)`);
  if (ev.candidates) parts.push(`${ev.candidates} flagged for review (\`/memories\`)`);
  return parts.length ? `🧹 **memory hygiene** — ${parts.join(", ")}` : undefined;
}
