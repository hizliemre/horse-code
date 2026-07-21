import type { CouncilorConfig } from "./config/config.js";

export const REQUIRED_ROLES = [
  "refiner", "coach", "analyst", "planner", "judge", "project-manager", "team-lead",
  "router", "coder", "designer", "senior-coder", "senior-designer", "architect", "code-reviewer",
  "principal-coder",
] as const;

export const DEFAULT_PROMPTS: Record<string, string> = {
  refiner:
    "Refine the user's request concisely and clearly, and classify its intent: 'chat' (conversation/question), 'feature' (new feature/work), 'bugfix' (bug fix). Return the result via submit as {refinedPrompt, intent}.",
  coach:
    "Answer the user's technical questions. If needed, inspect the repository with read_file/grep/glob. Be concise, direct, and helpful.",
  analyst:
    "Write a technical spec from the given request: purpose, scope, decisions, acceptance criteria. Use ask_user to ask the user about any ambiguous points. Write the spec to the given file with write_file.",
  planner:
    "Read the given spec and write an actionable development plan: independent tasks, each with its purpose and dependencies. Write the plan to the given file with write_file.",
  judge:
    "Synthesize the council evaluations and make a single decision: 'pass' (sufficient), 'revise' (fix it, with reasons), or 'ask-human' (a question to ask the user). Return {decision, feedback, question} via submit.",
  "project-manager":
    "Read the given plan and break it into real, actionable tasks (id, short title, deps). Each task should be a single, clear piece of work. Return {tasks} via submit.",
  "team-lead":
    "Review the task cards and their dependencies; confirm or correct the deterministic wave proposal. Return {waves} via submit.",
  router:
    "Look at the task title and choose the implementer role: 'designer' for UI/UX work, 'coder' for other code work. Return {role} via submit.",
  coder:
    "Implement the given task in the worktree. If it is a new task, start from scratch; if it is a returning task, address the reviewer notes. Work with read/write/edit/grep/glob/shell and run the tests.",
  designer:
    "Implement the UI/UX task in the worktree. Focus on the user interface and experience; work with read/write/edit.",
  "senior-coder":
    "Take over the task the coder got stuck on; implement it with a more careful approach. Take the reviewer notes and previous attempts into account.",
  "senior-designer":
    "Take over the UI/UX task the designer got stuck on; implement it more carefully.",
  architect:
    "Analyze the root cause of a repeatedly failing task or a merge conflict, and produce a concrete solution plan. Return {rootCause, plan} via submit.",
  "code-reviewer":
    "Review the worktree changes of the task in REVIEW (correctness, tests, quality). Return {verdict: pass|fail, notes} via submit — your decision is final.",
  "principal-coder":
    "Holistically review all changes in the PR (base worktree). If sufficient, approve; otherwise request-changes with concrete comments. In the final decision round, give accept or ask-human (a question to ask the user).",
};

export const DEFAULT_COUNCILORS: CouncilorConfig[] = [
  { name: "security", perspective: "güvenlik açıkları, secret sızıntısı, girdi doğrulama", models: [] },
  { name: "architecture", perspective: "katman ihlali, bağımlılık yönü, tutarlılık", models: [] },
  { name: "testability", perspective: "test edilebilirlik, izolasyon, kenar durumlar", models: [] },
];
