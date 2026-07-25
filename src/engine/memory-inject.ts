import { selectMemories, renderMemoryHints, memoryReferenced, type MemoryEntry } from "./memory-retrieval.js";
import type { TaskCycleDeps } from "./task-types.js";

/**
 * Relevant cross-session memory for ANY role, not just the coach.
 *
 * Rules ride every system prompt already (RoleRegistry.ruleSuffix). Facts and lessons did not: the analyst,
 * planner, implementers and reviewers had no access to what earlier runs learned, so they repeated the same
 * mistakes. This returns a ready-to-append user message with the memories that match `query`, plus the ids so
 * the caller can reinforce the ones the model actually used.
 */
export function memoryHints(deps: TaskCycleDeps, query: string, opts: { load?: number; role?: string } = {}): { message: string; ids: string[] } {
  const all: MemoryEntry[] = deps.memory?.() ?? [];
  // Rules are injected globally; selecting them here would duplicate them in every prompt.
  const selectable = all.filter((m) => (m.kind ?? "fact") !== "rule");
  if (!selectable.length) return { message: "", ids: [] };
  const hits = selectMemories(selectable, query, { load: opts.load ?? 0, ...(opts.role ? { role: opts.role } : {}) });
  if (!hits.length) return { message: "", ids: [] };
  return { message: renderMemoryHints(hits), ids: hits.map((h) => h.id) };
}

/** Credits the memories the model actually referenced in its output (feeds retrieval ranking). */
export function reinforceUsed(deps: TaskCycleDeps, ids: string[], output: string): void {
  if (!deps.reinforceMemory || !ids.length) return;
  const all = deps.memory?.() ?? [];
  for (const id of ids) {
    const e = all.find((m) => m.id === id);
    if (e && memoryReferenced(e, output)) deps.reinforceMemory(id);
  }
}
