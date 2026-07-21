import type { AgentEvent, Provider } from "../core/types.js";
import type { RoleConfig } from "../config/config.js";
import { runRoleAgent, type RoleAgentOptions } from "./loop.js";
import { applySkills } from "../skills/apply.js";
import type { SkillRegistry } from "../skills/registry.js";

export class RoleRegistry {
  private index = new Map<string, number>();
  private modelOverride?: string;

  constructor(
    private roles: Record<string, RoleConfig>,
    private defaultPrompts: Record<string, string> = {},
    private skillRegistry?: SkillRegistry,
  ) {}

  /** Live-swap the model used by every role (session-only; clears on undefined/empty). */
  setModelOverride(model?: string): void {
    this.modelOverride = model && model.length > 0 ? model : undefined;
  }

  resolve(roleName: string): { model: string; systemPrompt: string } {
    const role = this.roles[roleName];
    if (!role) throw new Error(`undefined role: ${roleName}`);
    if (!role.models.length) throw new Error(`role '${roleName}' has no model defined`);

    const i = this.index.get(roleName) ?? 0;
    const model = this.modelOverride ?? role.models[i % role.models.length];
    this.index.set(roleName, i + 1);

    let systemPrompt = role.systemPrompt ?? this.defaultPrompts[roleName];
    if (systemPrompt === undefined) throw new Error(`role '${roleName}' has no systemPrompt`);

    if (this.skillRegistry) {
      try {
        systemPrompt = applySkills(systemPrompt, role.skills ?? [], this.skillRegistry);
      } catch (e) {
        throw new Error(`role '${roleName}' skill error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return { model, systemPrompt };
  }
}

export function runRole(
  registry: RoleRegistry,
  provider: Provider,
  roleName: string,
  input: Omit<RoleAgentOptions, "provider" | "model" | "systemPrompt">,
): AsyncIterable<AgentEvent> {
  const { model, systemPrompt } = registry.resolve(roleName);
  return runRoleAgent({ provider, model, systemPrompt, ...input });
}
