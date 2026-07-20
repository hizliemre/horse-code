import type { AgentEvent, Provider } from "../core/types.js";
import type { RoleConfig } from "../config/config.js";
import { runRoleAgent, type RoleAgentOptions } from "./loop.js";
import { applySkills } from "../skills/apply.js";
import type { SkillRegistry } from "../skills/registry.js";

export class RoleRegistry {
  private index = new Map<string, number>();

  constructor(
    private roles: Record<string, RoleConfig>,
    private defaultPrompts: Record<string, string> = {},
    private skillRegistry?: SkillRegistry,
  ) {}

  resolve(roleName: string): { model: string; systemPrompt: string } {
    const role = this.roles[roleName];
    if (!role) throw new Error(`tanımsız role: ${roleName}`);
    if (!role.models.length) throw new Error(`role '${roleName}' için model tanımlı değil`);

    const i = this.index.get(roleName) ?? 0;
    const model = role.models[i % role.models.length];
    this.index.set(roleName, i + 1);

    let systemPrompt = role.systemPrompt ?? this.defaultPrompts[roleName];
    if (systemPrompt === undefined) throw new Error(`role '${roleName}' için systemPrompt yok`);

    if (this.skillRegistry) {
      try {
        systemPrompt = applySkills(systemPrompt, role.skills ?? [], this.skillRegistry);
      } catch (e) {
        throw new Error(`role '${roleName}' skill hatası: ${e instanceof Error ? e.message : String(e)}`);
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
