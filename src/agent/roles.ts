import type { AgentEvent, Provider } from "../core/types.js";
import type { RoleConfig } from "../config/config.js";
import { runRoleAgent, type RoleAgentOptions } from "./loop.js";
import { applySkills } from "../skills/apply.js";
import type { SkillRegistry } from "../skills/registry.js";

/** A resolved role: its primary model, the ordered fallback chain, prompt, and session-fallback hooks. */
export interface ResolvedRole {
  model: string;
  fallbacks: string[];
  systemPrompt: string;
  onExhausted: (model: string) => void;
  onFallback?: (from: string, to: string, reason: string) => void;
}

export class RoleRegistry {
  private modelOverride?: string;
  private roleOverrides = new Map<string, string[]>(); // per-role model CHAIN override (highest priority)
  private readonly exhausted = new Set<string>(); // models spent this session (429/5xx) → skipped in chains
  private notify?: (msg: string) => void; // fallback UI note sink (wired once the controller exists)
  private rulesProvider?: () => string[]; // durable behavioral rules → appended to EVERY role's prompt

  constructor(
    private roles: Record<string, RoleConfig>,
    private defaultPrompts: Record<string, string> = {},
    private skillRegistry?: SkillRegistry,
  ) {}

  /** Every configured role name — used to validate a role reference produced by a model (memory audiences). */
  names(): string[] {
    return [...new Set([...Object.keys(this.roles), ...Object.keys(this.defaultPrompts)])];
  }

  /** Wire the fallback-note sink (called after the controller exists). */
  setNotify(fn: (msg: string) => void): void {
    this.notify = fn;
  }

  /** Wire the durable-rules source (memory). Rules are appended to every role's system prompt (always honored). */
  setRules(fn: () => string[]): void {
    this.rulesProvider = fn;
  }

  /** The rule block to append to a role's prompt — empty when there are no rules. Public so prompt-supplying
   *  callers (spec-kit phases build their own prompt) can append it too. */
  ruleSuffix(): string {
    const rules = this.rulesProvider?.() ?? [];
    return rules.length ? `\n\nUser rules (ALWAYS honor these):\n${rules.map((r) => `- ${r}`).join("\n")}` : "";
  }

  /** Live-swap the model used by every role (session-only; clears on undefined/empty). */
  setModelOverride(model?: string): void {
    this.modelOverride = model && model.length > 0 ? model : undefined;
  }

  /** Live-swap the model CHAIN of ONE role (session-only; wins over the global override). Clears on empty. */
  setRoleModel(roleName: string, models?: string | string[]): void {
    const chain = (typeof models === "string" ? [models] : models ?? []).filter((m) => m.length > 0);
    if (chain.length) this.roleOverrides.set(roleName, chain);
    else this.roleOverrides.delete(roleName);
  }

  /** Mark a model spent for this session — every chain skips it from now on (until restart). */
  markExhausted(model: string): void {
    if (model) this.exhausted.add(model);
  }

  /** The full model chain for a role by priority: per-role override → global override (non-refiner) → config. */
  chain(roleName: string): string[] {
    const role = this.roles[roleName];
    if (!role || !role.models.length) return [];
    const perRole = this.roleOverrides.get(roleName);
    const base = perRole && perRole.length
      ? perRole
      : this.modelOverride && roleName !== "refiner"
        ? [this.modelOverride]
        : role.models;
    // Strict priority: primary first. Drop session-exhausted models, but never strand — if the whole chain
    // is spent, fall back to the raw chain (better to retry a spent model than to have no model at all).
    const live = base.filter((m) => !this.exhausted.has(m));
    return live.length ? live : base;
  }

  /** The model a role would use next (chain head), for UI display only. */
  peekModel(roleName: string): string {
    return this.chain(roleName)[0] ?? "";
  }

  /**
   * The chain (primary + fallbacks) and session-fallback hooks for a role, WITHOUT its system prompt —
   * for callers that supply their own prompt (e.g. spec-kit phases). resolve() layers the prompt on top.
   */
  fallbackOpts(roleName: string): Pick<ResolvedRole, "model" | "fallbacks" | "onExhausted" | "onFallback"> {
    const chain = this.chain(roleName);
    const notify = this.notify;
    return {
      model: chain[0] ?? "",
      fallbacks: chain.slice(1),
      onExhausted: (m) => this.markExhausted(m),
      onFallback: notify ? (from, to, reason) => notify(`⤵ ${from} unavailable (${reason}) — falling back to ${to}`) : undefined,
    };
  }

  resolve(roleName: string): ResolvedRole {
    const role = this.roles[roleName];
    if (!role) throw new Error(`undefined role: ${roleName}`);
    if (!role.models.length) throw new Error(`role '${roleName}' has no model defined`);

    let systemPrompt = role.systemPrompt ?? this.defaultPrompts[roleName];
    if (systemPrompt === undefined) throw new Error(`role '${roleName}' has no systemPrompt`);

    if (this.skillRegistry) {
      try {
        systemPrompt = applySkills(systemPrompt, role.skills ?? [], this.skillRegistry);
      } catch (e) {
        throw new Error(`role '${roleName}' skill error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return { ...this.fallbackOpts(roleName), systemPrompt: systemPrompt + this.ruleSuffix() };
  }
}

export function runRole(
  registry: RoleRegistry,
  provider: Provider,
  roleName: string,
  input: Omit<RoleAgentOptions, "provider" | "model" | "fallbacks" | "systemPrompt" | "onExhausted" | "onFallback">,
): AsyncIterable<AgentEvent> {
  const { model, fallbacks, systemPrompt, onExhausted, onFallback } = registry.resolve(roleName);
  return runRoleAgent({ provider, model, fallbacks, systemPrompt, onExhausted, onFallback, ...input });
}
