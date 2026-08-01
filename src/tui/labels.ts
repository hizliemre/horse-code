// Internal phase name → human-friendly (English) label. UI is English-only (i18n-ready).
export const PHASE_LABELS: Record<string, string> = {
  upstream: "refining…",
  worktree: "Preparing the workspace…",
  chat: "zottiring…",
  constitution: "Setting principles…",
  brainstorm: "Brainstorming the approach…",
  specify: "Writing spec…",
  clarify: "Clarifying…",
  plan: "Planning…",
  tasks: "Breaking into tasks…",
  rejected: "Rejected",
  approved: "Spec + plan approved",
  board: "Building tasks…",
  waves: "Coding…",
  "waves-done": "Coding done",
  pr: "Preparing PR…",
  revision: "Reviewing…",
  "revision-done": "Revision done",
  report: "Writing report…",
  tuning: "Assigning role models…",
  graph: "Reading the code…",
  planning: "Planning the trace run…",
  tracing: "Tracing files…",
  done: "Done ✓",
};

export function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? phase;
}

// Persistent chat-flow narration for the spec-kit authoring phases (the transient shimmer alone leaves
// the user unsure what's happening — especially the interactive constitution/specify steps that ask questions).
export const PHASE_NARRATION: Record<string, string> = {
  constitution: "**Establishing the project constitution** — I may ask you a few questions about core principles.",
  brainstorm: "**Brainstorming the approach** — I'll look at the repo, weigh a few options, and ask you to pick one. This is the decision point; everything after it runs on its own.",
  specify: "**Writing the feature spec** — I may ask a clarifying question or two.",
  clarify: "**Clarifying the spec** with you.",
  plan: "**Planning the implementation.**",
  tasks: "**Breaking the plan into tasks.**",
};

/** Chat-flow narration for a phase (undefined for phases that shouldn't be narrated into the flow). */
export function phaseNarration(phase: string): string | undefined {
  return PHASE_NARRATION[phase];
}

// Past-tense completion verb shown when a turn finishes: "zottired for 1m 23s".
export const DONE_PHRASES: Record<string, string> = {
  upstream: "refined",
  chat: "zottired",
  tuning: "assigned role models",
};

export function donePhrase(phase: string): string {
  return DONE_PHRASES[phase] ?? "done";
}
