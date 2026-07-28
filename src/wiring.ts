import { RoleRegistry } from "./agent/roles.js";
import { PermissionEngine } from "./permission/engine.js";
import type { PermissionRequest } from "./permission/engine.js";
import { buildTeamRegistry, buildCouncilRegistry, type ReviewStage } from "./engine/review.js";
import { InjectionLog } from "./engine/memory-retrieval.js";
import { MAX_PARALLEL_TASKS } from "./engine/wave-engine.js";
import { Timings } from "./engine/timings.js";
import { ProposalQueue } from "./engine/memory-proposals.js";
import { REQUIRED_ROLES, DEFAULT_PROMPTS, DEFAULT_ROLE_SKILLS, SPEC_TEAM, PLAN_TEAM, CODE_TEAM, DEFAULT_COUNCIL } from "./prompts.js";
import { UNSET_MODEL } from "./config/config.js";
import type { ResolvedConfig, RoleConfig, ReviewerConfig } from "./config/config.js";
import type { Provider } from "./core/types.js";
import type { FetchLike } from "./providers/omniroute.js";
import type { SkillRegistry } from "./skills/registry.js";
import type { WorktreeManager, PRAdapter } from "./worktree/manager.js";
import type { AskHuman } from "./engine/escalation.js";
import type { JobDeps } from "./engine/job.js";
import type { RevisionPRAdapter } from "./adapters/pr.js";
import { loadSpecKit } from "./speckit/templates.js";
import type { SpecKitTemplates } from "./speckit/templates.js";

export interface BuildJobDepsOpts {
  /** Live source of the durable behavioral rules → appended to EVERY role's system prompt. */
  rules?: () => string[];
  config: ResolvedConfig;
  provider: Provider;
  skillRegistry: SkillRegistry;
  manager: WorktreeManager;
  prAdapter: RevisionPRAdapter;
  askHuman: AskHuman;
  approve: (req: PermissionRequest) => Promise<boolean>;
  signal: AbortSignal;
  home: string;
  fetch?: FetchLike;
}

/** Builds a full JobDeps from config + defaults; every role gets resolved. */
export async function buildJobDeps(opts: BuildJobDepsOpts): Promise<JobDeps> {
  const { config } = opts;
  const roles: Record<string, RoleConfig> = {};
  /**
   * What a role with no configured models gets.
   *
   * `config.model` is the SESSION model, and until one is chosen it holds a placeholder that is not a model
   * id at all. Handing that out produced a role that failed on every call with "Unable to determine provider
   * for model 'default'" — and, before it was recognised for what it is, that error quarantined three working
   * models and re-chained fifty-eight roles per occurrence. An empty chain is the honest answer: it fails
   * once, loudly, at the role that is actually misconfigured.
   */
  const sessionChain = config.model === UNSET_MODEL ? [] : [config.model];
  for (const name of REQUIRED_ROLES) {
    // Skills and models are configured INDEPENDENTLY, so the two must merge rather than one replacing the
    // other. Taking a configured role as written looks reasonable until you notice that `/roles adjust`
    // persists `{models}` for every role: from then on every role counted as "configured", and every default
    // skill silently vanished — the tuner quietly unassigned every skill in the product.
    //
    // So `skills` is honoured only when the role actually DECLARES it. Declaring it empty is the supported way
    // to say "this role writes no tests" (or wants no design skill): `"coder": { "skills": [] }` beats an
    // opt-out flag because it reads as what it does and survives a re-tune.
    //
    // A skill that is not installed is dropped rather than throwing — the pipeline must still run in a
    // checkout without the bundled skills.
    const cfg = config.roles[name];
    const declared = cfg?.skills;
    const skills = (declared ?? DEFAULT_ROLE_SKILLS[name] ?? []).filter((s) => opts.skillRegistry.get(s));
    roles[name] = { ...(cfg ?? { models: sessionChain }), ...(skills.length ? { skills } : { skills: [] }) };
  }
  const roleRegistry = new RoleRegistry(roles, DEFAULT_PROMPTS, opts.skillRegistry);

  /**
   * A review lens takes its chain from `config.roles` when its own team entry does not carry one.
   *
   * The lens registries are built from `config.team` (or the shipped defaults), whose entries have NO models —
   * while `/roles adjust` writes every role's chain, lenses included, into `config.roles`. Nothing joined the
   * two, so a user with sixty-two carefully tuned roles still had fifteen lenses with an empty chain: they
   * resolved to the session placeholder, which is not a model id, and every code review failed. Seen live —
   * `stage.code_review` erroring in 48ms, every task blocked behind it.
   */
  const fillModels = (r: ReviewerConfig): ReviewerConfig => ({
    ...r,
    models: r.models.length > 0 ? r.models : (config.roles[r.name]?.models ?? sessionChain),
  });
  // One finder-lens set per review stage (a spec, a plan and code each need different questions asked).
  const teams: Record<ReviewStage, ReviewerConfig[]> = {
    spec: (config.team?.spec ?? SPEC_TEAM).map(fillModels),
    plan: (config.team?.plan ?? PLAN_TEAM).map(fillModels),
    code: (config.team?.code ?? CODE_TEAM).map(fillModels),
  };
  const teamRegistries: Record<ReviewStage, RoleRegistry> = {
    spec: buildTeamRegistry("spec", teams.spec),
    plan: buildTeamRegistry("plan", teams.plan),
    code: buildTeamRegistry("code", teams.code),
  };
  const council: ReviewerConfig[] = (config.council?.members ?? DEFAULT_COUNCIL).map(fillModels);
  const councilRegistry = buildCouncilRegistry(council);

  // RULES REACH EVERY AGENT — wired here, in the composition root, not in a UI entry point. Doing it in the TUI
  // meant the one-shot (`hcode "<prompt>"`) and headless paths ran with NO rules at all, and any new entry
  // point would silently repeat that. `rules` is a live getter, so a rule saved mid-session applies at once.
  if (opts.rules) {
    roleRegistry.setRules(opts.rules);
    for (const s of ["spec", "plan", "code"] as const) teamRegistries[s].setRules(opts.rules);
    councilRegistry.setRules(opts.rules);
  }

  const permission = new PermissionEngine({ mode: config.mode, allowlist: config.allowlist });

  // Review agents propose into this; nothing here is ever stored as written. The memory curator drains it at
  // the end of a job and decides what — if anything — becomes a real memory.
  const queue = new ProposalQueue();

  // Lazy + memoized: don't fetch spec-kit at build. A cold-cache fetch failure (bad tag, GitHub down) must
  // NOT brick plain chat, which never touches spec-kit. The pipeline calls specKit() on demand; the first
  // call caches the promise so repeated phases share one load.
  let kitPromise: Promise<SpecKitTemplates> | undefined;
  const specKit = () => (kitPromise ??= loadSpecKit({ version: config.specKit.version, home: opts.home, fetch: opts.fetch }));

  return {
    provider: opts.provider,
    roleRegistry,
    skillRegistry: opts.skillRegistry,
    permission,
    approve: opts.approve,
    signal: opts.signal,
    specKit,
    // One injection log per session: shared by the coach and every role so a memory shown to one agent is
    // not immediately re-shown to the next.
    injectionLog: new InjectionLog(),
    // One proposal queue per session: review agents propose into it, the curator drains it when a job ends.
    proposals: queue,
    proposeMemory: (text, kind, role) => queue.add(text, kind, role),
    teams,
    teamRegistries,
    councilRegistry,
    council,
    manager: opts.manager,
    prAdapter: opts.prAdapter,
    // One per job: every stage records into it, and the run reports the breakdown when the waves finish.
    timings: new Timings(),
    rounds: 3,
    maxParallel: opts.config.maxParallel ?? MAX_PARALLEL_TASKS,
    askHuman: opts.askHuman,
  };
}

/** H2 PRAdapter: logs the PR intent + returns a placeholder url (real MCP → G). */
export function logPRAdapter(log: (s: string) => void): RevisionPRAdapter {
  return {
    async createPR(input) {
      log(`PR would have been opened: ${input.branch} → ${input.base} — "${input.title}"`);
      return { url: "(pending: G — real MCP)" };
    },
    async postComments(comments) {
      if (comments.length) log(`PR comments: ${comments.join("; ")}`);
    },
  };
}
