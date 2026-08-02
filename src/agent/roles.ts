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
  onStructuralFailure: (model: string, reason?: string) => void;
  onFallback?: (from: string, to: string, reason: string) => void;
}

export class RoleRegistry {
  private modelOverride?: string;
  private roleOverrides = new Map<string, string[]>(); // per-role model CHAIN override (highest priority)
  // Models that failed retryably (429/5xx/quota) → skipped in every chain until released. Kept WITH the
  // reason and the time so a coordinator can report them and later re-probe whether the limit has reset.
  private readonly quarantine = new Map<string, { at: number; reason: string; until?: number }>();
  private notify?: (msg: string) => void; // fallback UI note sink (wired once the controller exists)
  private onQuarantine?: (model: string, reason: string) => void;
  /** What each model has actually managed to do in each ROLE — see setFitness. */
  private fitness?: { unfit(role: string, model: string): boolean; record?(role: string, model: string, reason: string): number };
  // Models that answered in prose instead of calling the submit tool. Not a transport error, so nothing ever
  // benched them: the chain quietly slid to the fallback on EVERY call, forever, in every role that held them.
  private readonly strikes = new Map<string, number>();
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

  /**
   * Wire the record of what each model has actually managed to do in each role.
   *
   * Without it a chain is only a list of names from a catalogue. With it, a model that has twice answered
   * this role in prose instead of doing its work stops being offered to this role — while staying available
   * to every other role, where it may be perfectly good.
   */
  setFitness(f: { unfit(role: string, model: string): boolean; record?(role: string, model: string, reason: string): number }): void {
    this.fitness = f;
  }

  /** Wire the quarantine hook: whatever benches a model, every role still holding it must be re-assigned. */
  setOnQuarantine(fn: (model: string, reason: string) => void): void {
    this.onQuarantine = fn;
  }

  /** Mark a model spent — every chain skips it from now on, until it is released. */
  markExhausted(model: string, reason = "unavailable", now = Date.now(), until?: number): void {
    if (!model || this.isQuarantined(model)) return;
    this.quarantine.set(model, { at: now, reason, ...(until !== undefined && { until }) });
    this.onQuarantine?.(model, reason);
  }

  /**
   * How long a BEHAVIOURAL bench lasts before the model is tried again.
   *
   * A model that is out of quota is out until the quota returns, and nothing here can shorten that. A model
   * that answered in prose is a different case entirely: the transport was fine, and the next prompt may not
   * be the one it stumbled on. Benching it for the rest of a multi-hour run costs every role that held it —
   * measured live, one such bench re-assigned SIXTEEN roles away from the best model available.
   */
  static readonly STRUCTURAL_BENCH_MS = 10 * 60_000;

  /**
   * How many structured failures a model gets before it is benched. One miss can be a genuinely hard prompt;
   * a pattern is the model. Low, because every strike costs a full wasted pass in every role that holds it.
   */
  static readonly STRUCTURAL_STRIKES = 2;

  /**
   * Records that a model finished a turn WITHOUT producing the structured result it was asked for (prose
   * instead of a tool call). This is not "unavailable" — the transport was fine — so it never reached the
   * retryable path that benches a model, and the chain slid to the fallback on every single call instead.
   * Returns the strike count; at the threshold the model is quarantined like any other spent one.
   */
  markStructuralFailure(model: string, reason = "no valid structured result", role?: string): number {
    if (!model) return 0;
    /**
     * Counted per ROLE, and only escalated to the whole model when the pattern is not about one role.
     *
     * The strike used to be global, so two misses in two different roles added up and benched the model
     * everywhere. Measured live: `cc/claude-opus-5` answered in prose twice and was re-assigned away from
     * SIXTEEN roles — the best model in the catalogue removed from every job in the run, because two prompts
     * had been hard.
     *
     * "This model cannot do THIS job" and "this model is broken" are different claims and want different
     * remedies. The first is what `fitness` already records — per role, leaving the model available
     * everywhere else. The second is a bench, and it should need evidence from more than one role.
     */
    const key = role ? `${model}::${role}` : model;
    const n = (this.strikes.get(key) ?? 0) + 1;
    this.strikes.set(key, n);
    if (n < RoleRegistry.STRUCTURAL_STRIKES) return n;

    if (role) {
      // This role stops offering it; every other role is untouched.
      this.fitness?.record?.(role, model, reason);
      const rolesFailed = [...this.strikes.entries()]
        .filter(([k, v]) => k.startsWith(`${model}::`) && v >= RoleRegistry.STRUCTURAL_STRIKES).length;
      // …unless it is failing this way in several roles, which is no longer a statement about any of them.
      if (rolesFailed >= RoleRegistry.STRUCTURAL_ROLES_BEFORE_BENCH) {
        this.markExhausted(model, `${reason} (in ${rolesFailed} roles)`, Date.now(),
          Date.now() + RoleRegistry.STRUCTURAL_BENCH_MS);
      }
      return n;
    }
    this.markExhausted(model, reason, Date.now(), Date.now() + RoleRegistry.STRUCTURAL_BENCH_MS);
    return n;
  }

  /**
   * How many DISTINCT roles must reject a model this way before it is benched outright.
   *
   * Two, because one role can have a prompt that a good model reads badly — and the fitness record already
   * takes it out of that role. A second, unrelated role failing the same way is the first evidence that the
   * model, not the prompt, is the problem.
   */
  static readonly STRUCTURAL_ROLES_BEFORE_BENCH = 2;

  /** Models currently quarantined, with why and when — surfaced to the user and re-probed before an adjust. */
  quarantined(): { model: string; at: number; reason: string }[] {
    return [...this.quarantine].map(([model, q]) => ({ model, ...q }));
  }

  isQuarantined(model: string, now = Date.now()): boolean {
    const q = this.quarantine.get(model);
    if (!q) return false;
    // A bench with an expiry is a behavioural one; once it lapses the model is in play again.
    if (q.until !== undefined && now >= q.until) { this.quarantine.delete(model); this.strikes.clear(); return false; }
    return true;
  }

  /** Put a model back in play (its quota reset, or the user forced it). */
  release(model: string): boolean {
    this.strikes.delete(model); // a released model starts clean; its old strikes describe a state that passed
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
    return raw.length > 0 && raw.every((m) => this.isQuarantined(m));
  }

  /** The full model chain for a role by priority: per-role override → global override (non-refiner) → config. */
  chain(roleName: string): string[] {
    const base = this.rawChain(roleName);
    if (!base.length) return [];
    // Strict priority: primary first. Drop quarantined models, but never strand — if the whole chain is spent,
    // fall back to the raw chain (better to retry a spent model than to have no model at all). `chainCollapsed`
    // is how a caller detects that this fallback is in effect and asks for a replacement chain instead.
    const live = base.filter((m) => !this.isQuarantined(m));
    const usable = live.length ? live : base;
    // Then drop what this ROLE has proven it cannot use. Never strand: a role with no model stops the run,
    // which is worse than a role with a model that wastes one attempt and rotates.
    const fit = this.fitness ? usable.filter((m) => !this.fitness!.unfit(roleName, m)) : usable;
    return fit.length ? fit : usable;
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
  fallbackOpts(roleName: string): Pick<ResolvedRole, "model" | "fallbacks" | "onExhausted" | "onStructuralFailure" | "onFallback"> {
    const chain = this.chain(roleName);
    const notify = this.notify;
    return {
      model: chain[0] ?? "",
      fallbacks: chain.slice(1),
      onExhausted: (m, reason) => this.markExhausted(m, reason ?? "unavailable"),
      onStructuralFailure: (m, reason) => this.markStructuralFailure(m, reason, roleName),
      onFallback: notify ? (from, to, reason) => notify(`⤵ \`${from}\` → \`${to}\` — ${reason}`) : undefined,
    };
  }

  /** The skills already attached to a role — what task-level routing must not inline a second time. */
  skillsFor(roleName: string): string[] {
    return this.roles[roleName]?.skills ?? [];
  }

  resolve(roleName: string): ResolvedRole {
    const role = this.roles[roleName];
    if (!role) throw new Error(`undefined role: ${roleName}`);
    if (!role.models.length) {
      throw new Error(
        `role '${roleName}' has no model defined — set one with \`/roles setmodel\`, run \`/roles adjust\`, ` +
        `or choose a session model with \`/model\`.`);
    }

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
