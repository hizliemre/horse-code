import type { Provider } from "../core/types.js";
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
}

export type ImplementerRole = "coder" | "designer";

export type RunnableRole = ImplementerRole | "senior-coder" | "senior-designer";

export interface Verdict {
  verdict: "pass" | "fail";
  notes: string[];
}
