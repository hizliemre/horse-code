import { RoleRegistry } from "./agent/roles.js";
import { PermissionEngine } from "./permission/engine.js";
import type { PermissionRequest } from "./permission/engine.js";
import { buildTeamRegistry, buildCouncilRegistry, type ReviewStage } from "./engine/review.js";
import { InjectionLog } from "./engine/memory-retrieval.js";
import { MAX_PARALLEL_TASKS } from "./engine/wave-engine.js";
import { proposeSplit } from "./engine/split-card.js";
import { SHORT_CALL_MS } from "./agent/deadline.js";
import { ToolRegistry } from "./tools/registry.js";
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
import { reviewThreadBody } from "./adapters/pr.js";
import type { RevisionPRAdapter } from "./adapters/pr.js";
import { loadSpecKit } from "./speckit/templates.js";
import type { SpecKitTemplates } from "./speckit/templates.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { RoleFitness } from "./engine/role-fitness.js";

export interface BuildJobDepsOpts {
  /** Live source of the durable behavioral rules → appended to EVERY role's system prompt. */
  rules?: () => string[];
  config: ResolvedConfig;
  provider: Provider;
  /**
   * Which CLI runs the implementers, or `null` to drive them through this process's own tool loop.
   *
   * `null` is what a caller injecting a non-CLI provider wants — a test with a mock, above all. Left unset
   * it defaults to delegating, because the provider this ships with is a CLI.
   */
  delegateTo?: import("./agents/cli-agent.js").CliKind | null;
  /** The one pool every delegated call shares. Omitted, calls run under the ambient login. */
  accounts?: import("./agents/cli-accounts.js").AccountPool;
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
   * How many accounts each subscription has, so the head rotation spreads waves in proportion to what is
   * actually paying for them. Read live rather than copied: `count` reflects the pool this session built,
   * and connecting an account has to change the share rather than only the fallbacks.
   */
  if (opts.accounts) {
    const pool = opts.accounts;
    roleRegistry.setSourceWeights(() => ({
      claude: pool.count("claude"), codex: pool.count("codex"), grok: pool.count("grok"),
    }));
  }

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

  /**
   * What each model has managed to do in each role, kept across sessions.
   *
   * Lives beside the config rather than inside it: config.json holds the user's API key, and a file that
   * rewrites itself on every strike does not belong next to a secret.
   */
  const fitness = new RoleFitness(join(opts.home ?? homedir(), ".horsecode", "model-fitness.json"));
  roleRegistry.setFitness(fitness);

  return {
    provider: opts.provider,
    /**
     * Implementers run as the CLI, because with a CLI provider nothing else can write.
     *
     * A CLI answers with TEXT. It never emits a tool call — it ran its tools itself, in its own process — so
     * an implementer driven through this process's loop would receive prose, execute nothing, and report
     * `no_changes` for every task on the board. This is not a choice between two working paths.
     *
     * It belongs HERE and not inside `runJob`, because it is a property of the provider that was chosen. Set
     * in the pipeline it would override every caller that injected one: the job tests hand in a mock and
     * would have spawned the real binary instead, which is exactly how it was first written and exactly how
     * the tests caught it.
     *
     * `claude` is the fallback, not the decision — `cliFor` reads each role's own chain head, so a role on a
     * `gpt-*` model runs Codex.
     */
    ...(opts.delegateTo === null ? {} : { delegateTo: opts.delegateTo ?? "claude" }),
    ...(opts.accounts ? { accounts: opts.accounts } : {}),
    roleRegistry,
    fitness,
    skillRegistry: opts.skillRegistry,
    permission,
    approve: opts.approve,
    signal: opts.signal,
    home: opts.home,
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
    /**
     * Cutting a stuck card up, asked of the role that owns breakdowns in the first place.
     *
     * Read-only tools: this is a planning question about a card that already exists, and a splitter with a
     * writer's toolset would be tempted to start doing the work it is describing.
     */
    splitCard: async (card: import("./board/board.js").Card) => {
      const resolved = roleRegistry.resolve("project-manager");
      return proposeSplit({
        provider: opts.provider, ...resolved,
        tools: new ToolRegistry(),   // a planning question about a card that exists; it needs no tools
        messages: [], permission, approve: opts.approve, cwd: process.cwd(), signal: opts.signal,
        // It reads a card and answers; anything longer is exploring, which is not what was asked.
        maxTurns: 3,
        perAttemptMs: SHORT_CALL_MS,
      }, card);
    },
  };
}

/** H2 PRAdapter: logs the PR intent + returns a placeholder url (real MCP → G). */
export function logPRAdapter(log: (s: string) => void): RevisionPRAdapter {
  return {
    async createPR(input) {
      log(`PR would have been opened: ${input.branch} → ${input.base} — "${input.title}"`);
      return { url: "(pending: G — real MCP)" };
    },
    async postComments(comments, outcome) {
      if (comments.length || outcome === "approved") log(`PR review: ${reviewThreadBody(comments, outcome)}`);
      return undefined;
    },
    async replyAndResolve(_threadId, body) { log(`PR thread reply: ${body}`); },
    async resolveOwnThreads() { /* nothing was opened */ },
  };
}
