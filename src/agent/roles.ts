import type { AgentEvent, Provider } from "../core/types.js";
import type { RoleConfig } from "../config/config.js";
import { runRoleAgent, type RoleAgentOptions } from "./loop.js";
import { applySkills } from "../skills/apply.js";
import type { SkillRegistry } from "../skills/registry.js";

export class RoleRegistry {
  private index = new Map<string, number>();
  private modelOverride?: string;
  private roleOverrides = new Map<string, string>(); // per-role model override (highest priority)

  constructor(
    private roles: Record<string, RoleConfig>,
    private defaultPrompts: Record<string, string> = {},
    private skillRegistry?: SkillRegistry,
  ) {}

  /** Live-swap the model used by every role (session-only; clears on undefined/empty). */
  setModelOverride(model?: string): void {
    this.modelOverride = model && model.length > 0 ? model : undefined;
  }

  /** Live-swap the model of ONE role (session-only; wins over the global override). Clears on empty. */
  setRoleModel(roleName: string, model?: string): void {
    if (model && model.length > 0) this.roleOverrides.set(roleName, model);
    else this.roleOverrides.delete(roleName);
  }

  /** Resolves the model for a role by priority: per-role override → global override (non-refiner) → config. */
  private modelFor(roleName: string, role: RoleConfig): string {
    const perRole = this.roleOverrides.get(roleName);
    if (perRole) return perRole;
    const i = this.index.get(roleName) ?? 0;
    return this.modelOverride && roleName !== "refiner" ? this.modelOverride : role.models[i % role.models.length];
  }

  /** The model a role would use next, WITHOUT advancing the round-robin index (for UI display only). */
  peekModel(roleName: string): string {
    const role = this.roles[roleName];
    if (!role || !role.models.length) return "";
    return this.modelFor(roleName, role);
  }

  resolve(roleName: string): { model: string; systemPrompt: string } {
    const role = this.roles[roleName];
    if (!role) throw new Error(`undefined role: ${roleName}`);
    if (!role.models.length) throw new Error(`role '${roleName}' has no model defined`);

    // Priority: per-role override → global override (non-refiner) → configured round-robin.
    const model = this.modelFor(roleName, role);
    const i = this.index.get(roleName) ?? 0;
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
