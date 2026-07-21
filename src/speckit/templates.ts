import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { FetchLike } from "../providers/omniroute.js";

const TEMPLATE_FILES = {
  spec: "spec-template.md",
  plan: "plan-template.md",
  tasks: "tasks-template.md",
  constitution: "constitution-template.md",
  checklist: "checklist-template.md",
} as const;
const COMMAND_FILES = {
  constitution: "commands/constitution.md",
  specify: "commands/specify.md",
  clarify: "commands/clarify.md",
  plan: "commands/plan.md",
  tasks: "commands/tasks.md",
} as const;

type TemplateName = keyof typeof TEMPLATE_FILES;
type CommandName = keyof typeof COMMAND_FILES;

export interface SpecKitTemplates {
  version: string;
  template(name: TemplateName): string;
  command(name: CommandName): string;
}

const RAW_BASE = "https://raw.githubusercontent.com/github/spec-kit";

/** Loads spec-kit templates for a pinned tag: serves from the on-disk cache, fetching any missing file once. */
export async function loadSpecKit(opts: {
  version: string;
  home: string;
  fetch?: FetchLike;
}): Promise<SpecKitTemplates> {
  if (!/^[A-Za-z0-9._-]+$/.test(opts.version) || opts.version.includes("..")) {
    throw new Error(
      `spec-kit version "${opts.version}" is not a valid spec-kit release tag ` +
        `(expected only letters, digits, dots, underscores, and hyphens, with no ".." segment).`,
    );
  }
  const fetchFn = opts.fetch ?? (globalThis.fetch as FetchLike);
  const cacheDir = join(opts.home, ".horsecode", "spec-kit", opts.version, "templates");

  const get = async (relPath: string): Promise<string> => {
    const cachePath = join(cacheDir, relPath);
    if (existsSync(cachePath)) return readFileSync(cachePath, "utf8");
    const url = `${RAW_BASE}/${opts.version}/templates/${relPath}`;
    const res = await fetchFn(url);
    if (!res.ok) {
      throw new Error(
        `spec-kit template fetch failed (${res.status}): ${url}\n` +
          `Check your network or set specKit.version to a valid tag.`,
      );
    }
    const text = await res.text();
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, text, "utf8");
    return text;
  };

  const templates: Record<string, string> = {};
  for (const [name, file] of Object.entries(TEMPLATE_FILES)) templates[name] = await get(file);
  const commands: Record<string, string> = {};
  for (const [name, file] of Object.entries(COMMAND_FILES)) commands[name] = await get(file);

  return {
    version: opts.version,
    template: (name) => templates[name],
    command: (name) => commands[name],
  };
}
