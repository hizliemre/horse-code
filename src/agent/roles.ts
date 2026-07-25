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
  onExhausted: (model: string, reason?: string) => void;
  onFallback?: (from: string, to: string, reason: string) => void;
}

export class RoleRegistry {
  private modelOverride?: string;
  private roleOverrides = new Map<string, string[]>(); // per-role model CHAIN override (highest priority)
  // Models that failed retryably (429/5xx/quota) → skipped in every chain until released. Kept WITH the
  // reason and the time so a coordinator can report them and later re-probe whether the limit has reset.
  private readonly quarantine = new Map<string, { at: number; reason: string }>();
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

  /** Mark a model spent — every chain skips it from now on, until it is released. */
  markExhausted(model: string, reason = "unavailable", now = Date.now()): void {
    if (model && !this.quarantine.has(model)) this.quarantine.set(model, { at: now, reason });
  }

  /** Models currently quarantined, with why and when — surfaced to the user and re-probed before an adjust. */
  quarantined(): { model: string; at: number; reason: string }[] {
    return [...this.quarantine].map(([model, q]) => ({ model, ...q }));
  }

  isQuarantined(model: string): boolean {
    return this.quarantine.has(model);
  }

  /** Put a model back in play (its quota reset, or the user forced it). */
  release(model: string): boolean {
    return this.quarantine.delete(model);
  }

  /**
   * Roles whose CURRENT chain still contains `model`. When a model is quarantined these are the roles that
   * would otherwise keep resolving to a dead chain, so they are exactly the ones to re-assign.
   */
  rolesUsing(model: string): string[] {
    return this.names().filter((r) => this.rawChain(r).includes(model));
  }

  /** The role's chain BEFORE quarantine filtering — what was actually assigned to it. */
  rawChain(roleName: string): string[] {
    const role = this.roles[roleName];
    if (!role || !role.models.length) return [];
    const perRole = this.roleOverrides.get(roleName);
    if (perRole && perRole.length) return perRole;
    if (this.modelOverride && roleName !== "refiner") return [this.modelOverride];
    return role.models;
  }

  /** True when every model assigned to this role is quarantined — the chain has collapsed and needs replacing. */
  chainCollapsed(roleName: string): boolean {
    const raw = this.rawChain(roleName);
    return raw.length > 0 && raw.every((m) => this.quarantine.has(m));
  }

  /** The full model chain for a role by priority: per-role override → global override (non-refiner) → config. */
  chain(roleName: string): string[] {
    const base = this.rawChain(roleName);
    if (!base.length) return [];
    // Strict priority: primary first. Drop quarantined models, but never strand — if the whole chain is spent,
    // fall back to the raw chain (better to retry a spent model than to have no model at all). `chainCollapsed`
    // is how a caller detects that this fallback is in effect and asks for a replacement chain instead.
    const live = base.filter((m) => !this.quarantine.has(m));
    return live.length ? live : base;
  }

  /**
   * The role's chain ROTATED by `slot`. Parallel workers share one role — five implementers in a wave are all
   * `coder` — so every one of them resolved to the same chain head and hammered a single subscription until it
   * rate-limited. Rotating gives each worker a different lead model while keeping its FULL fallback set, so
   * spreading the load costs no resilience.
   */
  chainFor(roleName: string, slot = 0): string[] {
    const c = this.chain(roleName);
    const k = c.length ? ((slot % c.length) + c.length) % c.length : 0;
    return k === 0 ? c : [...c.slice(k), ...c.slice(0, k)];
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
      onExhausted: (m, reason) => this.markExhausted(m, reason ?? "unavailable"),
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
