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
/**
 * `readOnly` marks a server whose tools only read. Such tools are handed to EVERY agent and skip the approval
 * gate; without it a server's tools reach only the one agent allowed to run exec-level tools. Say it only for
 * a server you know cannot mutate anything.
 */
export type McpServerSpec =
  | { command: string[]; env?: Record<string, string>; readOnly?: boolean } // stdio: spawn a local server
  | { url: string; headers?: Record<string, string>; readOnly?: boolean }; // remote: streamable-http / SSE

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
  /**
   * Where `/graph trace` writes, repo-relative. Empty = `.horsecode/traces`.
   *
   * A project whose generated file-documentation already has a home points this at it, so the two kinds do
   * not end up in separate roots that nobody keeps in step.
   */
  traceDir?: string;
  /**
   * How many implementation tasks may run at once.
   *
   * The right number is a property of YOUR subscriptions, not of the tool: it is bounded by how many parallel
   * calls your model sources tolerate and by how much of the machine you want spent. It is a setting because
   * no default can know that.
   */
  maxParallel: number;
  /**
   * Whether every stage, model call and tool call is recorded to a local JSONL log.
   *
   * On by default: it is a few hundred kilobytes an hour, written fire-and-forget, and the alternative is
   * answering "why was that slow" by reading a board file and counting outcomes — which is how every such
   * question in this project was answered before it existed.
   */
  telemetry: boolean;
}

/**
 * The stand-in used when no session model has been chosen yet.
 *
 * It is NOT a model id — the gateway cannot resolve it, and a role that reaches a request holding it fails
 * with "Unable to determine provider for model 'default'". Exported so the places that must never dispatch
 * it can say so by name rather than by guessing at the string.
 */
export const UNSET_MODEL = "default";

export const DEFAULT_CONFIG: ResolvedConfig = {
  baseUrl: "http://localhost:20128",
  model: UNSET_MODEL,
  // acceptEdits: auto-approve file writes/edits (the pipeline builds in an isolated worktree → reviewed as a
  // PR), still prompt for shell/exec. Keeps the automated build flowing without an approval per file.
  mode: "acceptEdits",
  allowlist: [],
  roles: {},
  specKit: { version: "v0.13.2" },
  mcp: {},
  modelSources: [],
  traceDir: "",
  skillSources: [],
  maxParallel: 8,
  telemetry: true,
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
    traceDir: z.string().optional(), // where /graph trace writes; empty = .horsecode/traces
    // Bounded: below 1 nothing runs; above 32 the git merge lock, not the models, becomes the limit.
    maxParallel: z.number().int().min(1).max(32).optional(),
    telemetry: z.boolean().optional(),
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
          z.object({ command: z.array(z.string()).min(1), env: z.record(z.string(), z.string()).optional(), readOnly: z.boolean().optional() }),
          z.object({ url: z.string(), headers: z.record(z.string(), z.string()).optional(), readOnly: z.boolean().optional() }),
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

  // maxParallel: most specific wins — a heavy project may want a different number from the machine default.
  merged.maxParallel = projectSafe.maxParallel ?? global.maxParallel ?? DEFAULT_CONFIG.maxParallel;
  merged.telemetry = projectSafe.telemetry ?? global.telemetry ?? DEFAULT_CONFIG.telemetry;

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
