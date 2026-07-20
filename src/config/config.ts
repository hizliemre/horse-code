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

// Dosyalardan okunabilecek alanlar (hepsi opsiyonel).
const fileSchema = z
  .object({
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    model: z.string().optional(),
    mode: z.enum(["ask", "acceptEdits", "auto"]).optional(),
    allowlist: z.array(z.string()).optional(),
    roles: z
      .record(
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
    return {}; // bozuk JSON → katmanı yok say
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

  // Güvenlik: proje config'i apiKey taşıyamaz.
  const { apiKey: _leak, ...projectSafe } = project;

  const merged: ResolvedConfig = {
    ...DEFAULT_CONFIG,
    ...global,
    ...projectSafe,
  } as ResolvedConfig;

  // allowlist için birleştirme yerine "en spesifik kazanır" (project varsa onu al).
  merged.allowlist = projectSafe.allowlist ?? global.allowlist ?? [];

  // roles: global + proje shallow merge (aynı adlı role projede ezilir).
  merged.roles = { ...(global.roles ?? {}), ...(projectSafe.roles ?? {}) };

  // env en yüksek öncelik.
  if (opts.env.OMNIROUTE_API_KEY) merged.apiKey = opts.env.OMNIROUTE_API_KEY;
  if (opts.env.OMNIROUTE_BASE_URL) merged.baseUrl = opts.env.OMNIROUTE_BASE_URL;

  return merged;
}
