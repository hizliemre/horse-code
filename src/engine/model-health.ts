// Model health: what happens when a model stops answering.
//
// A role carries a chain (primary + fallbacks). When one model 429s or errors the chain slides to the next —
// but nothing ever REPLACED a spent model, so once a whole chain was spent that role was dead for the rest of
// the session and reported "UNVERIFIED (no response)" on every round. Worse, the spent model usually sat in
// several other roles' chains too, so the failure spread quietly.
//
// This coordinates the response: quarantine what died, hand every affected role a fresh chain built only from
// healthy models, and — because a quota limit is temporary — re-probe the quarantine so recovered models come
// back into the pool instead of being written off for the whole session.

import type { RoleRegistry } from "../agent/roles.js";
import { isUnknownModelError } from "../providers/omniroute.js";
import { adjustRoleModels } from "../tui/role-models.js";

/** The role↔registry map, supplied by the composition root (roles live in several separate registries). */
export interface RoleModelPort {
  /** Every assignable role name: the main roles + each stage's review lenses + the council. */
  roles(): string[];
  /** Every registry that assigns models — a quarantine must apply to all of them, not just one. */
  registries(): RoleRegistry[];
  /** The registry that owns this role. */
  registryFor(role: string): RoleRegistry;
}

export interface ModelHealthOpts {
  /** What each model has actually managed to do in each role — see RoleFitness. */
  fitness?: { unfit(role: string, model: string): boolean };
  port: RoleModelPort;
  listModels: () => Promise<string[]>;
  /**
   * Strict health check: true only when the model actually answers. Note this is deliberately STRICTER than
   * the source-discovery probe, which counts 429 as "routed" — a rate-limited model is precisely what we
   * quarantined, so treating it as healthy would put it straight back into service.
   */
  probe?: (model: string) => Promise<boolean>;
  note?: (msg: string) => void;
  now?: () => number;
}

/** Result of healing one role. `chain` is empty when no healthy model could be found at all. */
export interface Rechained {
  role: string;
  chain: string[];
}

export class ModelHealth {
  private readonly port: RoleModelPort;
  /** What each model has actually managed to do in each role — see RoleFitness. */
  private readonly fitness?: { unfit(role: string, model: string): boolean };
  private readonly listModels: () => Promise<string[]>;
  private readonly probe?: (model: string) => Promise<boolean>;
  private readonly note: (msg: string) => void;
  private readonly now: () => number;
  /** Serializes healing: a whole review team failing at once must not trigger 14 concurrent re-assignments. */
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Registers the sweep with every registry, so a model benched for ANY reason — a 429, or repeated prose
   * where a structured result was required — immediately takes every role that still holds it off it. Without
   * this, only a TOTAL chain collapse triggered a re-assignment, so a merely-degraded model stayed at the head
   * of a dozen chains and each of them slid past it on every call.
   */
  watch(): void {
    for (const r of this.port.registries()) r.setOnQuarantine((m, reason) => { void this.sweep(m, reason); });
  }

  /** Re-chains every role still holding `model`. Fire-and-forget: healing must never block the caller. */
  private async sweep(model: string, reason: string): Promise<void> {
    return this.serialize(async () => {
      const affected = new Set<string>();
      for (const r of this.port.registries()) for (const role of r.rolesUsing(model)) affected.add(role);
      if (!affected.size) return;
      const healthy = await this.healthyModels();
      if (!healthy.length) return;
      const moved = this.reassign([...affected], healthy);
      if (moved.length) {
        this.note(`⛔ **Benched** \`${model}\` (${reason.slice(0, 100)}) — re-assigned ${moved.length} role(s) that were using it.`);
      }
    });
  }

  constructor(opts: ModelHealthOpts) {
    this.port = opts.port;
    this.listModels = opts.listModels;
    this.probe = opts.probe;
    this.note = opts.note ?? ((): void => {});
    this.now = opts.now ?? ((): number => Date.now());
    this.fitness = opts.fitness;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Every model currently quarantined anywhere, de-duplicated. */
  quarantined(): { model: string; at: number; reason: string }[] {
    const seen = new Map<string, { model: string; at: number; reason: string }>();
    for (const r of this.port.registries()) for (const q of r.quarantined()) if (!seen.has(q.model)) seen.set(q.model, q);
    return [...seen.values()];
  }

  /** Marks a model spent in EVERY registry — a chain in one registry must not keep using what another buried. */
  private mark(model: string, reason: string): void {
    for (const r of this.port.registries()) r.markExhausted(model, reason, this.now());
  }

  /** Models that may be assigned right now: the catalog minus everything quarantined. */
  async healthyModels(): Promise<string[]> {
    const dead = new Set(this.quarantined().map((q) => q.model));
    let all: string[];
    try { all = await this.listModels(); } catch { return []; }
    return all.filter((m) => !dead.has(m));
  }

  /**
   * Re-probes the quarantine and releases whatever answers again. A 429 is a temporary limit, not a permanent
   * fact, so writing a model off for the whole session throws away capacity the moment the window resets.
   * Returns the models put back into service.
   */
  async refresh(): Promise<string[]> {
    const probe = this.probe;
    if (!probe) return [];
    const held = this.quarantined();
    if (!held.length) return [];
    const checked = await Promise.all(held.map(async (q) => ({ model: q.model, ok: await probe(q.model).catch(() => false) })));
    const released = checked.filter((c) => c.ok).map((c) => c.model);
    for (const m of released) for (const r of this.port.registries()) r.release(m);
    if (released.length) this.note(`♻️ **Back in service** — ${released.join(", ")} answered again and left quarantine.`);
    return released;
  }

  /**
   * A role's whole chain failed. Quarantines the models it was using, gives that role a fresh chain, and
   * re-chains every OTHER role that was relying on the same models — those roles have not failed YET, but they
   * are already holding a dead chain and would fail the same way the moment they run.
   *
   * Returns the replacement chain for `role`, or undefined when no healthy model is available.
   */
  async handleChainFailure(role: string, reason: string): Promise<string[] | undefined> {
    return this.serialize(async () => {
      const reg = this.port.registryFor(role);
      const spent = reg.rawChain(role);
      if (!spent.length) return undefined;
      /**
       * A model id the gateway cannot resolve says nothing about any model's HEALTH.
       *
       * Observed: one role holding the placeholder id failed with "Unable to determine provider for model
       * 'default'", and that error quarantined the three WORKING models the role had been assigned, then
       * re-chained fifty-eight other roles onto a pool that had just shrunk — which produced the next
       * failure, and the next. Fifteen review lenses went down in a row over an id none of them was using.
       *
       * The role still needs a working chain, so it is re-assigned; nothing is taken out of service for it.
       */
      if (isUnknownModelError(reason)) {
        const healthy = await this.healthyModels();
        if (!healthy.length) return undefined;
        this.note(`⚠️ \`${role}\` was pointed at a model the gateway does not know (${reason.slice(0, 80)}) — re-assigning it; no model was benched.`);
        const mine = this.reassign([role], healthy)[0];
        return mine?.chain.length ? mine.chain : undefined;
      }
      const fresh = spent.filter((m) => !reg.isQuarantined(m));
      for (const m of spent) this.mark(m, reason);
      if (fresh.length) {
        this.note(`⛔ **Quarantined** ${fresh.join(", ")} — \`${role}\`'s whole chain failed (${reason.slice(0, 120)}).`);
      }

      const healthy = await this.healthyModels();
      if (!healthy.length) {
        this.note(`⚠️ No healthy model left to reassign \`${role}\` — every known model is quarantined.`);
        return undefined;
      }

      // This role first, so the caller can retry immediately…
      const mine = this.reassign([role], healthy)[0];
      // …then every other role still holding one of the dead models, so the failure does not spread run by run.
      const affected = new Set<string>();
      for (const m of spent) for (const r of this.port.registries()) for (const other of r.rolesUsing(m)) if (other !== role) affected.add(other);
      const others = this.reassign([...affected], healthy);
      if (others.length) {
        this.note(`🔁 **Re-assigned** ${others.length} other role(s) that were still on the quarantined model(s).`);
      }
      return mine?.chain.length ? mine.chain : undefined;
    });
  }

  /** Assigns each role a fresh chain drawn only from `healthy`, and applies it to its own registry. */
  private reassign(roles: string[], healthy: string[]): Rechained[] {
    if (!roles.length) return [];
    // The re-assignment reads the record of what each model has managed in each role. Without it, benching
    // one model hands its roles to whatever the catalogue ranks next — including models already known to be
    // useless there, which is how a coder chain filled up with models that only ever answered in prose.
    const picked = adjustRoleModels(roles, healthy, this.fitness ? (r, m) => this.fitness!.unfit(r, m) : undefined);
    const out: Rechained[] = [];
    for (const { role, models } of picked) {
      const chain = models.filter((m) => healthy.includes(m));
      if (!chain.length) continue;
      this.port.registryFor(role).setRoleModel(role, chain);
      out.push({ role, chain });
    }
    return out;
  }
}
