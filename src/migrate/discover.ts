import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Finding what another coding tool left behind in a project.
 *
 * A project developed with Claude Code, Codex, Cursor or Copilot carries months of accumulated instruction:
 * a CLAUDE.md nobody wants to rewrite, a memory directory of corrections the user gave one at a time, MCP
 * servers already configured. Starting horse-code in that project without any of it throws all of it away,
 * and the user finds out by watching agents repeat mistakes that were solved a year ago.
 *
 * Discovery is deterministic and offline: it looks in known locations for known formats. What any of it
 * MEANS — whether a line is a durable rule for us or an instruction about a tool we do not have — is a
 * separate judgement, made later and with the user in the loop.
 */

export type SourceKind = "rules" | "memory" | "skill" | "mcp" | "agent" | "command";

export interface Finding {
  kind: SourceKind;
  /** Which tool left it, for the user to recognise. */
  tool: string;
  /** Absolute path. */
  path: string;
  /** Repo-relative or ~-relative, for display. */
  label: string;
  bytes: number;
  /** File content, read for everything small enough to act on. */
  text?: string;
}

/** Rule files, by the tool that writes them. The list is what these tools actually use, not a guess. */
const RULE_FILES: { file: string; tool: string }[] = [
  { file: "CLAUDE.md", tool: "Claude Code" },
  { file: "CLAUDE.local.md", tool: "Claude Code" },
  { file: "AGENTS.md", tool: "Codex / OpenAI" },
  { file: "GEMINI.md", tool: "Gemini CLI" },
  { file: ".cursorrules", tool: "Cursor" },
  { file: ".windsurfrules", tool: "Windsurf" },
  { file: ".clinerules", tool: "Cline" },
  { file: ".continuerules", tool: "Continue" },
  { file: ".aider.conf.yml", tool: "Aider" },
  { file: "CONVENTIONS.md", tool: "Aider" },
  { file: ".rules", tool: "Zed" },
  { file: ".github/copilot-instructions.md", tool: "GitHub Copilot" },
  /**
   * Not a tool's file — the project's own design system, which several skills read as their source of truth.
   *
   * It is here because it is instruction material by any test that matters: a real project's DESIGN.md held
   * 17 KB of binding conventions (tokens, type scale, spacing, what never to do), and leaving it behind meant
   * every agent rebuilt its taste from scratch while the answer sat in the repo root.
   */
  { file: "DESIGN.md", tool: "project convention" },
];

/** Directories of rule fragments — a newer convention than one big file. */
const RULE_DIRS: { dir: string; tool: string; ext: RegExp }[] = [
  { dir: ".cursor/rules", tool: "Cursor", ext: /\.mdc?$/ },
  { dir: ".github/instructions", tool: "GitHub Copilot", ext: /\.md$/ },
];

/** Anything bigger than this is reported but not read into a prompt. */
export const MAX_FINDING_BYTES = 60_000;

/**
 * Claude Code's per-project directory name: the absolute path with separators replaced by dashes.
 *
 * Derived rather than searched because the mapping is exact, and scanning every project directory to find
 * one by guesswork would be both slower and wrong when two checkouts share a basename.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

async function read(path: string): Promise<{ bytes: number; text?: string } | undefined> {
  try {
    const s = await stat(path);
    if (!s.isFile() || s.size === 0) return undefined;
    if (s.size > MAX_FINDING_BYTES) return { bytes: s.size };
    return { bytes: s.size, text: await readFile(path, "utf8") };
  } catch {
    return undefined;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

export interface DiscoverOptions {
  cwd: string;
  home: string;
}

/**
 * Everything another tool left, in one pass.
 *
 * Never throws: a directory we cannot read is simply not a finding. Migration must be able to run against
 * any project, including one where most of these paths do not exist.
 */
export async function discover(opts: DiscoverOptions): Promise<Finding[]> {
  const { cwd, home } = opts;
  const out: Finding[] = [];
  const push = async (kind: SourceKind, tool: string, path: string, label: string): Promise<void> => {
    const r = await read(path);
    if (r) out.push({ kind, tool, path, label, bytes: r.bytes, ...(r.text ? { text: r.text } : {}) });
  };

  // Project rule files, plus the user-level CLAUDE.md — the second holds standing preferences ("never use
  // language X") that are exactly the kind of thing that must not be lost in a move.
  for (const { file, tool } of RULE_FILES) await push("rules", tool, join(cwd, file), file);
  await push("rules", "Claude Code (user-level)", join(home, ".claude", "CLAUDE.md"), "~/.claude/CLAUDE.md");
  await push("rules", "Codex (user-level)", join(home, ".codex", "AGENTS.md"), "~/.codex/AGENTS.md");

  for (const { dir, tool, ext } of RULE_DIRS) {
    for (const name of await listDir(join(cwd, dir))) {
      if (ext.test(name)) await push("rules", tool, join(cwd, dir, name), `${dir}/${name}`);
    }
  }

  // Claude Code's memory: one file per fact, under a per-project directory keyed by the absolute path.
  const memDir = join(home, ".claude", "projects", claudeProjectSlug(cwd), "memory");
  for (const name of await listDir(memDir)) {
    if (!name.endsWith(".md") || name === "MEMORY.md") continue; // MEMORY.md is an index of the rest
    await push("memory", "Claude Code", join(memDir, name), `memory/${name}`);
  }

  /**
   * Skills already written for this project transfer as they are — same format, same idea.
   *
   * Two roots, because both conventions are in use: `.claude/skills` and the tool-agnostic `.agents/skills`.
   * A skill present in both is taken once (the first root wins) — the same skill offered twice is a worse
   * question than a missing one.
   *
   * A skill directory may be a SYMLINK, and this is where the old scan lost work: `Dirent.isDirectory()`
   * reflects lstat, so it is FALSE for a link to a directory. Measured on a real project: 13 of its 76
   * skills were symlinks into `.agents/skills`, and every one of them was silently skipped — including the
   * design skills the migration was being run for. Directory-ness is tested by following the link.
   */
  const seenSkills = new Set<string>();
  for (const [rel, tool] of [[".claude/skills", "Claude Code"], [".agents/skills", "agent skills"]] as const) {
    const skillsDir = join(cwd, rel);
    let entries;
    try { entries = await readdir(skillsDir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (seenSkills.has(e.name)) continue;
      if (!e.isDirectory()) {
        if (!e.isSymbolicLink()) continue;
        try { if (!(await stat(join(skillsDir, e.name))).isDirectory()) continue; } catch { continue; }
      }
      const before = out.length;
      await push("skill", tool, join(skillsDir, e.name, "SKILL.md"), `${rel}/${e.name}`);
      if (out.length > before) seenSkills.add(e.name); // only count it when a SKILL.md was actually there
    }
  }

  // MCP servers are configuration, not prose: they transfer exactly, and losing them silently breaks tools
  // the project depends on.
  for (const [file, tool] of [[".mcp.json", "Claude Code"], [".cursor/mcp.json", "Cursor"], [".vscode/mcp.json", "VS Code"]] as const) {
    await push("mcp", tool, join(cwd, file), file);
  }
  for (const settings of [".claude/settings.json", ".claude/settings.local.json"]) {
    await push("mcp", "Claude Code", join(cwd, settings), settings);
  }

  // Subagents and slash commands are reported but are a different shape from ours — the user should know
  // they exist rather than discover later that something was silently dropped.
  for (const [dir, kind] of [[".claude/agents", "agent"], [".claude/commands", "command"]] as const) {
    for (const name of await listDir(join(cwd, dir))) {
      if (name.endsWith(".md")) await push(kind, "Claude Code", join(cwd, dir, name), `${dir}/${name}`);
    }
  }

  return out;
}

/** A one-line-per-group summary of what was found. */
export function summarize(findings: Finding[]): string {
  if (!findings.length) return "No configuration from another coding tool was found in this project.";
  const byKind = new Map<SourceKind, Finding[]>();
  for (const f of findings) {
    const list = byKind.get(f.kind);
    if (list) list.push(f); else byKind.set(f.kind, [f]);
  }
  const LABEL: Record<SourceKind, string> = {
    rules: "Instruction files", memory: "Remembered facts", skill: "Skills",
    mcp: "MCP / settings", agent: "Subagents", command: "Slash commands",
  };
  const rows: string[] = [];
  for (const kind of ["rules", "memory", "skill", "mcp", "agent", "command"] as SourceKind[]) {
    const list = byKind.get(kind);
    if (!list?.length) continue;
    const tools = [...new Set(list.map((f) => f.tool))].join(", ");
    const files = list.slice(0, 4).map((f) => `\`${f.label}\``).join(", ");
    const more = list.length > 4 ? ` +${list.length - 4} more` : "";
    rows.push(`- **${LABEL[kind]}** (${list.length}, from ${tools}): ${files}${more}`);
  }
  return rows.join("\n");
}

/** Whether there is anything worth migrating at all. */
export function hasAnything(findings: Finding[]): boolean {
  return findings.some((f) => f.kind === "rules" || f.kind === "memory" || f.kind === "skill" || f.kind === "mcp");
}
