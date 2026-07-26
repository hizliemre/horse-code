import { z } from "zod";
import type { PermissionMode } from "../core/types.js";

export interface RoleConfig {
  models: string[];
  systemPrompt?: string;
  skills?: string[];
}

/** A named reviewer with a viewpoint + its model chain. Used for BOTH the review team (finders) and the
 *  review council (deciders). */
export interface ReviewerConfig {
  name: string;
  perspective: string;
  models: string[];
}
/** @deprecated legacy alias — the team's members were formerly called "councilors". */
export type CouncilorConfig = ReviewerConfig;

/** An MCP server to connect at startup: local (stdio subprocess) or remote (http/sse URL). */
export type McpServerSpec =
  | { command: string[]; env?: Record<string, string> } // stdio: spawn a local server
  | { url: string; headers?: Record<string, string> }; // remote: streamable-http / SSE

export interface ResolvedConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  mode: PermissionMode;
  allowlist: string[];
  roles: Record<string, RoleConfig>;
  // Two-stage review bodies. `team` holds the finder lenses PER STAGE (a spec, a plan and code each need
  // different questions asked); `council` is the small strong panel that votes on contested work. Any absent
  // set is filled in by wiring from SPEC_TEAM / PLAN_TEAM / CODE_TEAM / DEFAULT_COUNCIL.
  team?: { spec?: ReviewerConfig[]; plan?: ReviewerConfig[]; code?: ReviewerConfig[] };
  council?: { members: ReviewerConfig[] };
  specKit: { version: string };
  mcp: Record<string, McpServerSpec>;
  /**
   * Skills installed from a git repository instead of shipped here. Kept as a reference, not a copy: upstream
   * stays the single source of truth and `/skills update` is a real operation.
   */
  skillSources: { name: string; repo: string; path?: string; ref?: string }[];
  /** Allowlist of model sources (omniroute `owned_by`) to show; empty = all (non-free). Only your connected
   *  subscriptions, e.g. ["antigravity","claude","codex","opencode-go"] — excludes combos + unofficial sources. */
  modelSources: string[];
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  baseUrl: "http://localhost:20128",
  model: "default",
  // acceptEdits: auto-approve file writes/edits (the pipeline builds in an isolated worktree → reviewed as a
  // PR), still prompt for shell/exec. Keeps the automated build flowing without an approval per file.
  mode: "acceptEdits",
  allowlist: [],
  roles: {},
  specKit: { version: "v0.13.2" },
  mcp: {},
  modelSources: [],
  skillSources: [],
};

const reviewerSchema = z.object({ name: z.string(), perspective: z.string(), models: z.array(z.string()) });

// Fields that can be read from files (all optional).
const fileSchema = z
  .object({
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    model: z.string().optional(),
    mode: z.enum(["ask", "acceptEdits", "auto"]).optional(),
    allowlist: z.array(z.string()).optional(),
    roles: z
      .record(
        z.string(),
        z.object({
          models: z.array(z.string()),
          systemPrompt: z.string().optional(),
          skills: z.array(z.string()).optional(),
        }),
      )
      .optional(),
    // The review team's finder lenses, one set per stage (any omitted set falls back to the built-in default).
    team: z
      .object({
        spec: z.array(reviewerSchema).optional(),
        plan: z.array(reviewerSchema).optional(),
        code: z.array(reviewerSchema).optional(),
      })
      .optional(),
    council: z.object({ members: z.array(reviewerSchema) }).optional(),
    specKit: z.object({ version: z.string() }).optional(),
    modelSources: z.array(z.string()).optional(),
    skillSources: z.array(z.object({
      name: z.string(),
      repo: z.string(),
      path: z.string().optional(),
      ref: z.string().optional(),
    })).optional(),
    mcp: z
      .record(
        z.string(),
        z.union([
          z.object({ command: z.array(z.string()).min(1), env: z.record(z.string(), z.string()).optional() }),
          z.object({ url: z.string(), headers: z.record(z.string(), z.string()).optional() }),
        ]),
      )
      .optional(),
  })
  .partial();

type FileConfig = z.infer<typeof fileSchema>;

function parseFile(raw: string | undefined): FileConfig {
  if (!raw) return {};
  try {
    const parsed = fileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {}; // malformed JSON → ignore this layer
  }
}

export interface LoadOptions {
  cwd: string;
  home: string;
  env: NodeJS.ProcessEnv;
  readFile: (path: string) => string | undefined;
}

export function loadConfig(opts: LoadOptions): ResolvedConfig {
  const global = parseFile(opts.readFile(`${opts.home}/.horsecode/config.json`));
  const project = parseFile(opts.readFile(`${opts.cwd}/.horsecode/config.json`));

  // Security: project config cannot carry an apiKey.
  const { apiKey: _leak, ...projectSafe } = project;

  const merged: ResolvedConfig = {
    ...DEFAULT_CONFIG,
    ...global,
    ...projectSafe,
  } as ResolvedConfig;

  // For allowlist, "most specific wins" instead of merging (use project's if present).
  merged.allowlist = projectSafe.allowlist ?? global.allowlist ?? [];

  // roles: shallow merge of global + project (same-named role is overridden by project).
  merged.roles = { ...(global.roles ?? {}), ...(projectSafe.roles ?? {}) };

  // mcp: shallow merge of global + project (same-named server overridden by project).
  merged.mcp = { ...(global.mcp ?? {}), ...(projectSafe.mcp ?? {}) };

  // modelSources: "most specific wins" (project's if present).
  merged.modelSources = projectSafe.modelSources ?? global.modelSources ?? [];

  // skillSources MERGE by name: a machine-wide skill set stays available in every project, and a project may
  // add its own or pin a different ref for one of them.
  const byName = new Map((global.skillSources ?? []).map((s) => [s.name, s]));
  for (const s of projectSafe.skillSources ?? []) byName.set(s.name, s);
  merged.skillSources = [...byName.values()];

  // specKit: "most specific wins" instead of merging (use project's if present).
  merged.specKit = projectSafe.specKit ?? global.specKit ?? DEFAULT_CONFIG.specKit;

  // Review bodies (most-specific wins, per stage — a project may override just one stage's lenses).
  const team = {
    spec: projectSafe.team?.spec ?? global.team?.spec,
    plan: projectSafe.team?.plan ?? global.team?.plan,
    code: projectSafe.team?.code ?? global.team?.code,
  };
  merged.team = team.spec || team.plan || team.code ? team : undefined;
  const councilMembers = projectSafe.council?.members ?? global.council?.members;
  merged.council = councilMembers ? { members: councilMembers } : undefined;

  // env has the highest priority.
  if (opts.env.OMNIROUTE_API_KEY) merged.apiKey = opts.env.OMNIROUTE_API_KEY;
  if (opts.env.OMNIROUTE_BASE_URL) merged.baseUrl = opts.env.OMNIROUTE_BASE_URL;

  return merged;
}
