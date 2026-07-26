import { GRAPH_TOOLS } from "../tools/graph.js";
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
  /** Wall-clock ceiling for one implementation attempt; defaults to IMPLEMENTER_TIMEOUT_MS. Lowered by tests. */
  implementerTimeoutMs?: number;
  /**
   * Live progress sink. The REVIEW path threaded its own `emit` down its call chain, so per-agent metering
   * landed there; the implementer path had no such channel and its rows showed a bare clock. This is that
   * channel, so both kinds of agent feed the SAME row renderer with the same data.
   */
  onProgress?: (ev: import("./progress.js").ProgressEvent) => void;
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
  /** Shared per-session record of what was recently injected → stops re-sending the same memory every turn. */
  injectionLog?: import("./memory-retrieval.js").InjectionLog;
  /** remember_fact tool sink: persist a durable fact the model learned from a tool result. */
  rememberFact?: (fact: string) => void;
  /**
   * Queue a memory PROPOSAL from a review agent. Nothing is written here — the curator rules on the queue once
   * the job ends. Returns whether it was queued (false = duplicate or queue full).
   */
  proposeMemory?: (text: string, kind: "fact" | "lesson", role: string) => boolean;
  /** The per-job proposal queue itself — drained once by the curator when the job ends. */
  proposals?: import("./memory-proposals.js").ProposalQueue;
  /**
   * A role's whole model chain failed. Quarantines the spent models, re-chains this role AND every other role
   * still holding them, and returns the replacement chain so the caller can retry once. Undefined = nothing
   * healthy left to assign.
   */
  rechainRole?: (role: string, reason: string) => Promise<string[] | undefined>;
  /** Durable injection counter — distinguishes "never relevant" from "never came up" (feeds hygiene). */
  recordInjection?: (ids: string[]) => void;
  /** Memory telemetry sink: what was injected/used/learned, and why the rest was skipped. Wired to chat. */
  onMemory?: (ev: import("./memory-inject.js").MemoryEvent) => void;
  /**
   * Writes a memory the auto-extractor derived from a finished job. Separate from `rememberFact` because it is
   * unsupervised: it carries provenance, an audience and a below-certain confidence.
   */
  learnMemory?: (
    text: string,
    kind: "fact" | "lesson",
    opts: { learnedBy: string; audience?: string[]; importance?: number; confidence?: number },
  ) => Promise<boolean>;
  /** Mutable holder for the compaction summary cache (persists across coach turns within a session). */
  compactionState?: { value?: import("./compaction.js").CompactionCache };
  /** Tools discovered from connected MCP servers → added to the coach's toolset (getter: filled once connected). */
  mcpTools?: () => import("../core/types.js").Tool[];
}

export type ImplementerRole = "coder" | "designer";

export type RunnableRole = ImplementerRole | "senior-coder" | "senior-designer";

export interface Verdict {
  /**
   * The attempt changed NOTHING — no file was written at all. Distinct from a failed review: there is no work
   * to improve, so repeating the same role with the same instruction is provably futile.
   */
  noProgress?: boolean;
  /** Medium/low review findings that did NOT block this task — carried to the PR revision pass, never dropped. */
  deferred?: string[];
  verdict: "pass" | "fail";
  notes: string[];
}

/**
 * Every read-only tool that helps an agent understand the project it is working in.
 *
 * The code-graph lookups plus whatever read-only MCP servers are connected. Handed to EVERY agent, because an
 * agent that cannot see the project it is changing is the failure this exists to fix: a coder about to edit a
 * function needs to know what calls it, and a reviewer needs to know how far a change reaches.
 */
export function contextTools(deps: { mcpTools?: () => import("../core/types.js").Tool[] }): import("../core/types.js").Tool[] {
  return [...GRAPH_TOOLS, ...mcpReadTools(deps)];
}

/**
 * The MCP tools that only read — the ones every agent may hold.
 *
 * An agent that cannot see the project it is changing is the failure this addresses: a coder about to edit a
 * function needs to know what calls it, and a reviewer needs to know how far a change reaches. Those lookups
 * change nothing, so there is no reason to keep them from any agent, and every reason not to.
 *
 * Tools that can mutate stay out. They remain exec-level and reach only the agent explicitly given them.
 */
export function mcpReadTools(deps: { mcpTools?: () => import("../core/types.js").Tool[] }): import("../core/types.js").Tool[] {
  return (deps.mcpTools?.() ?? []).filter((t) => t.permissionLevel === "safe");
}
