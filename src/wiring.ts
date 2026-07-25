import { RoleRegistry } from "./agent/roles.js";
import { PermissionEngine } from "./permission/engine.js";
import type { PermissionRequest } from "./permission/engine.js";
import { buildTeamRegistry, buildCouncilRegistry, type ReviewStage } from "./engine/review.js";
import { REQUIRED_ROLES, DEFAULT_PROMPTS, SPEC_TEAM, PLAN_TEAM, CODE_TEAM, DEFAULT_COUNCIL } from "./prompts.js";
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
  for (const name of REQUIRED_ROLES) {
    roles[name] = config.roles[name] ?? { models: [config.model] };
  }
  const roleRegistry = new RoleRegistry(roles, DEFAULT_PROMPTS, opts.skillRegistry);

  const fillModels = (r: ReviewerConfig): ReviewerConfig => ({ ...r, models: r.models.length > 0 ? r.models : [config.model] });
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
    teams,
    teamRegistries,
    councilRegistry,
    council,
    manager: opts.manager,
    prAdapter: opts.prAdapter,
    rounds: 3,
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
