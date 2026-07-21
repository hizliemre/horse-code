// Internal phase name → human-friendly (English) label. UI is English-only (i18n-ready).
export const PHASE_LABELS: Record<string, string> = {
  upstream: "refining…",
  chat: "zottiring…",
  rejected: "Rejected",
  approved: "Spec + plan approved",
  board: "Building tasks…",
  waves: "Coding…",
  "waves-done": "Coding done",
  pr: "Preparing PR…",
  revision: "Reviewing…",
  "revision-done": "Revision done",
  report: "Writing report…",
  done: "Done ✓",
};

export function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? phase;
}

// Past-tense completion verb shown when a turn finishes: "zottired for 1m 23s".
export const DONE_PHRASES: Record<string, string> = {
  upstream: "refined",
  chat: "zottired",
};

export function donePhrase(phase: string): string {
  return DONE_PHRASES[phase] ?? "done";
}
