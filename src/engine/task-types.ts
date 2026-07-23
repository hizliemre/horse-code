import type { Provider, ToolActivity } from "../core/types.js";
import type { PermissionEngine, PermissionRequest } from "../permission/engine.js";
import type { RoleRegistry } from "../agent/roles.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { SpecKitTemplates } from "../speckit/templates.js";

export interface TaskCycleDeps {
  provider: Provider;
  roleRegistry: RoleRegistry;
  skillRegistry: SkillRegistry;
  permission: PermissionEngine;
  approve: (req: PermissionRequest) => Promise<boolean>;
  signal: AbortSignal;
  /** Memoized, lazy loader for the spec-kit templates — only invoked by the feature/bugfix pipeline, never by chat. */
  specKit: () => Promise<SpecKitTemplates>;
  /** Live file-write/edit activity sink (wired to the TUI); undefined in headless/one-shot runs. */
  onActivity?: (a: ToolActivity) => void;
  /** Live "writing <file> · N chars" progress while a tool call is still being generated (long writes). */
  onLiveActivity?: (label: string) => void;
  /** Persistent chat-flow note sink (wired to the TUI) — e.g. each auto-commit surfaces here. */
  note?: (text: string) => void;
  /** "By-the-way" note source: the coach loop polls it each turn to fold in mid-run guidance. */
  inbox?: () => string | undefined;
  /** Context pins: short user facts injected into the system prompt every turn (survive compaction). */
  pins?: () => string[];
  /** Cross-session memory snapshot: durable facts, retrieved lexically + injected into relevant turns. */
  memory?: () => import("./memory-retrieval.js").MemoryEntry[];
  /** Reinforce a memory the model actually cited this turn (feeds ranking). */
  reinforceMemory?: (id: string) => void;
  /** remember_fact tool sink: persist a durable fact the model learned from a tool result. */
  rememberFact?: (fact: string) => void;
  /** Mutable holder for the compaction summary cache (persists across coach turns within a session). */
  compactionState?: { value?: import("./compaction.js").CompactionCache };
  /** Tools discovered from connected MCP servers → added to the coach's toolset (getter: filled once connected). */
  mcpTools?: () => import("../core/types.js").Tool[];
}

export type ImplementerRole = "coder" | "designer";

export type RunnableRole = ImplementerRole | "senior-coder" | "senior-designer";

export interface Verdict {
  verdict: "pass" | "fail";
  notes: string[];
}
