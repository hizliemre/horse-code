import { RoleRegistry } from "./agent/roles.js";
import { PermissionEngine } from "./permission/engine.js";
import type { PermissionRequest } from "./permission/engine.js";
import { buildCouncilRegistry } from "./engine/review.js";
import { REQUIRED_ROLES, DEFAULT_PROMPTS, DEFAULT_COUNCILORS } from "./prompts.js";
import type { ResolvedConfig, RoleConfig, CouncilorConfig } from "./config/config.js";
import type { Provider } from "./core/types.js";
import type { SkillRegistry } from "./skills/registry.js";
import type { WorktreeManager, PRAdapter } from "./worktree/manager.js";
import type { AskHuman } from "./engine/escalation.js";
import type { JobDeps } from "./engine/job.js";
import type { RevisionPRAdapter } from "./adapters/pr.js";

export interface BuildJobDepsOpts {
  config: ResolvedConfig;
  provider: Provider;
  skillRegistry: SkillRegistry;
  manager: WorktreeManager;
  prAdapter: RevisionPRAdapter;
  askHuman: AskHuman;
  approve: (req: PermissionRequest) => Promise<boolean>;
  signal: AbortSignal;
}

/** Config + varsayılanlardan tam bir JobDeps kurar; her rol resolve olur. */
export function buildJobDeps(opts: BuildJobDepsOpts): JobDeps {
  const { config } = opts;
  const roles: Record<string, RoleConfig> = {};
  for (const name of REQUIRED_ROLES) {
    roles[name] = config.roles[name] ?? { models: [config.model] };
  }
  const roleRegistry = new RoleRegistry(roles, DEFAULT_PROMPTS, opts.skillRegistry);

  const councilors: CouncilorConfig[] = (config.council?.councilors ?? DEFAULT_COUNCILORS).map((c) => ({
    ...c,
    models: c.models.length > 0 ? c.models : [config.model],
  }));
  const councilRegistry = buildCouncilRegistry(councilors);

  const permission = new PermissionEngine({ mode: config.mode, allowlist: config.allowlist });

  return {
    provider: opts.provider,
    roleRegistry,
    skillRegistry: opts.skillRegistry,
    permission,
    approve: opts.approve,
    signal: opts.signal,
    councilRegistry,
    councilors,
    manager: opts.manager,
    prAdapter: opts.prAdapter,
    rounds: 3,
    askHuman: opts.askHuman,
  };
}

/** H2 PRAdapter'ı: PR intent'ini loglar + placeholder url döner (gerçek MCP → G). */
export function logPRAdapter(log: (s: string) => void): RevisionPRAdapter {
  return {
    async createPR(input) {
      log(`PR açılacaktı: ${input.branch} → ${input.base} — "${input.title}"`);
      return { url: "(pending: G — gerçek MCP)" };
    },
    async postComments(comments) {
      if (comments.length) log(`PR yorumları: ${comments.join("; ")}`);
    },
  };
}
