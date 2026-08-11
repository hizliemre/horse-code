import {
  selectMemoriesDetailed, renderMemoryHints, memoryReferenced,
  type MemoryEntry, type SelectedMemory, type SelectionStats,
} from "./memory-retrieval.js";
import type { TaskCycleDeps } from "./task-types.js";
import { telemetry } from "../obs/telemetry.js";

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
/**
 * The standing question every task asks and no task text ever contains.
 *
 * Retrieval scores a memory against the task, and how a project is BUILT is never what a task is about.
 * Measured live: a card titled "Fix the issue in step 2 of the product creation wizard where the drag
 * placeholder scales up" retrieved thirteen memories — the wizard's six steps, a table's placeholder rows,
 * the product's typography — and then the implementer spent eight consecutive failed shell calls guessing at
 * `nx test products`, `vitest --config …`, `prettier --check`, `dotnet build src/api/api.csproj`.
 *
 * The store had the answer the whole time, written by an earlier session: "The toucan repository uses npm,
 * not pnpm — invoke targets as `npx nx <target> <project>`" and "For verifying Angular changes, build the
 * beempa app (`npx nx build beempa --skip-nx-cache`)". Neither shares a word with a drag placeholder, so
 * neither could ever be retrieved by the task that needed them — nor by any other task, ever.
 */
export const OPERATIONS_QUERY =
  "how this project is built, tested, linted and run: the command, the package manager, the workspace, the "
  + "script, the target, how to verify a change locally";

/** How many of the injected memories are reserved for it — a couple of lines, not a manual. */
export const OPERATIONS_SLOTS = 3;

export function memoryHints(
  deps: TaskCycleDeps,
  query: string,
  opts: {
    load?: number; role?: string; silent?: boolean;
    /** Reserve slots for how the project is operated. Set by roles that RUN things — they all need it. */
    operations?: boolean;
  } = {},
): MemoryHints {
  const all: MemoryEntry[] = deps.memory?.() ?? [];
  // Rules are injected globally; selecting them here would duplicate them in every prompt.
  const selectable = all.filter((m) => (m.kind ?? "fact") !== "rule");
  /**
   * A miss is recorded too, and says WHICH miss it was.
   *
   * There are two ways to inject nothing and they were both silent, so a log showing no injections could not
   * distinguish "this role never consults memory" from "it consulted 721 memories and none applied" from
   * "the store it was pointed at was empty". Measured on an 82-call run: zero injection records, a store with
   * 746 entries on disk, and selection demonstrably returning five hits for the same role when run by hand —
   * three incompatible facts that no amount of staring at the log could reconcile, because the log recorded
   * only the outcome that did not happen.
   */
  const miss = (reason: "empty-store" | "no-match", stats: SelectionStats): MemoryHints => {
    telemetry().event("memory.missed", {
      "hc.role": opts.role ?? "coach",
      "hc.memory.reason": reason,
      "hc.memory.available": all.length,
      "hc.memory.considered": selectable.length,
      "hc.memory.query_chars": query.length,
      "hc.memory.rejected": `below:${stats.belowThreshold} cooldown:${stats.cooldown} `
        + `audience:${stats.audience} inactive:${stats.inactive} budget:${stats.budget}`,
    });
    return { message: "", ids: [], hits: [], stats };
  };
  if (!selectable.length) return miss("empty-store", { ...EMPTY_STATS });
  const common = {
    load: opts.load ?? 0,
    ...(opts.role ? { role: opts.role } : {}),
    ...(deps.injectionLog ? { log: deps.injectionLog } : {}),
  };
  const { hits: bySubject, stats } = selectMemoriesDetailed(selectable, query, common);
  /**
   * …and a few for the question the subject cannot ask. See OPERATIONS_QUERY.
   *
   * A second pass rather than a widened query: mixing the two into one string would let the operational words
   * compete with the task's own, and the task's own are the ones that must win the other slots.
   */
  const byOperations = opts.operations
    ? selectMemoriesDetailed(selectable, OPERATIONS_QUERY, { ...common, max: OPERATIONS_SLOTS }).hits
    : [];
  const already = new Set(bySubject.map((h) => h.entry.id));
  const ops = byOperations.filter((h) => !already.has(h.entry.id)).slice(0, OPERATIONS_SLOTS);
  const hits = [...bySubject, ...ops];
  if (!hits.length) return miss("no-match", stats);
  const ids = hits.map((h) => h.entry.id);
  deps.injectionLog?.record(ids, Date.now()); // don't re-send these on the next turn
  deps.recordInjection?.(ids); // durable count → "injected ten times, never cited" becomes visible
  if (!opts.silent) deps.onMemory?.({ kind: "injected", role: opts.role ?? "coach", hits, stats });
  const message = renderMemoryHints(hits.map((h) => h.entry));
  /**
   * …and recorded, not only shown.
   *
   * The event above reaches the screen and nowhere else, so "which memories did this run actually use, and
   * what did they cost?" was answerable only by watching it happen. Measured on a 53-call run: 2,111
   * `process.memory` samples in the log and not one record of an injection — the mechanism was working and
   * unmeasurable, which is the same position the constitution was in before it was labelled.
   *
   * The ids and the size, not the text: the text is in `memory.jsonl`, and a log that copies it grows by the
   * size of everything it observes.
   */
  telemetry().event("memory.injected", {
    "hc.role": opts.role ?? "coach",
    "hc.memory.ids": ids.join(","),
    "hc.memory.count": hits.length,
    // Measurable on its own: "how is this built" is a different need from "what is this about".
    "hc.memory.operations": ops.length,
    "hc.memory.chars": message.length,
    "hc.memory.considered": stats.considered,
    "hc.memory.top_relevance": Math.round((hits[0]?.relevance ?? 0) * 100) / 100,
    // Why the rest did not make it — a selection that drops everything for one reason is a selection to look at.
    "hc.memory.rejected": `below:${stats.belowThreshold} cooldown:${stats.cooldown} `
      + `audience:${stats.audience} inactive:${stats.inactive} budget:${stats.budget}`,
  });
  return { message, ids, hits, stats };
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
  recordUse(role, ids, used, "anchor");
}

/**
 * Which of the injected memories actually earned their place, and how it was decided.
 *
 * Paired with `memory.injected` on the ids, so a reader can compute the thing that matters — how much of what
 * was sent was used — without holding the run in their head. `via` because the two credit paths answer
 * different questions: `anchor` means an implementer went to the file the memory is about, `cited` means a
 * model's own words repeated it, and a mechanism that only ever credits one of them is measuring one role.
 */
function recordUse(role: string, injected: string[], used: MemoryEntry[], via: "anchor" | "cited"): void {
  telemetry().event("memory.used", {
    "hc.role": role,
    "hc.memory.via": via,
    "hc.memory.ids": used.map((e) => e.id).join(","),
    "hc.memory.used": used.length,
    "hc.memory.injected": injected.length,
  });
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
  recordUse(role, ids, used, "cited");
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
