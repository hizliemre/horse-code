import { z } from "zod";
import type { PermissionMode } from "../core/types.js";

export interface ResolvedConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  mode: PermissionMode;
  allowlist: string[];
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  baseUrl: "http://localhost:20128",
  model: "default",
  mode: "ask",
  allowlist: [],
};

// Dosyalardan okunabilecek alanlar (hepsi opsiyonel).
const fileSchema = z
  .object({
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    model: z.string().optional(),
    mode: z.enum(["ask", "acceptEdits", "auto"]).optional(),
    allowlist: z.array(z.string()).optional(),
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

  // env en yüksek öncelik.
  if (opts.env.OMNIROUTE_API_KEY) merged.apiKey = opts.env.OMNIROUTE_API_KEY;
  if (opts.env.OMNIROUTE_BASE_URL) merged.baseUrl = opts.env.OMNIROUTE_BASE_URL;

  return merged;
}
