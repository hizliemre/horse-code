import type { LineReader } from "./terminal.js";

export interface InitIO {
  read: LineReader;
  readFile: (path: string) => string | undefined;
  writeFile: (path: string, content: string) => void;
  home: string;
  log: (s: string) => void;
}

const DEFAULT_BASE_URL = "http://localhost:20128";
const DEFAULT_MODEL = "auto/best-coding";

function parseExisting(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Interactive setup: asks for baseUrl + apiKey, writes a merge-preserving update to the global config. */
export async function runInit(io: InitIO): Promise<void> {
  const path = `${io.home}/.horsecode/config.json`;
  const existing = parseExisting(io.readFile(path));
  const baseUrl = (await io.read(`omniroute baseUrl [${DEFAULT_BASE_URL}]: `)).trim() || DEFAULT_BASE_URL;
  const apiKey = (await io.read("omniroute apiKey (empty=none): ")).trim();
  const config: Record<string, unknown> = {
    ...existing,
    baseUrl,
    model: existing.model ?? DEFAULT_MODEL,
  };
  if (apiKey) config.apiKey = apiKey;
  else delete config.apiKey;
  io.writeFile(path, JSON.stringify(config, null, 2) + "\n");
  io.log(`config written: ${path} (apiKey: ${apiKey ? "set" : "none"})`);
}
