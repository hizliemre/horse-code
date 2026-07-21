import { z } from "zod";
import type { PermissionMode } from "../core/types.js";

export interface RoleConfig {
  models: string[];
  systemPrompt?: string;
  skills?: string[];
}

export interface CouncilorConfig {
  name: string;
  perspective: string;
  models: string[];
}

export interface ResolvedConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  mode: PermissionMode;
  allowlist: string[];
  roles: Record<string, RoleConfig>;
  council?: { councilors: CouncilorConfig[] };
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  baseUrl: "http://localhost:20128",
  model: "default",
  mode: "ask",
  allowlist: [],
  roles: {},
};

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
    council: z
      .object({
        councilors: z.array(
          z.object({ name: z.string(), perspective: z.string(), models: z.array(z.string()) }),
        ),
      })
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

  // env has the highest priority.
  if (opts.env.OMNIROUTE_API_KEY) merged.apiKey = opts.env.OMNIROUTE_API_KEY;
  if (opts.env.OMNIROUTE_BASE_URL) merged.baseUrl = opts.env.OMNIROUTE_BASE_URL;

  return merged;
}
