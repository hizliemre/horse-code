import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import type { Tool } from "../core/types.js";
import type { SkillRegistry } from "./registry.js";

/** Appends mandatory skill contents and a discoverable listing to basePrompt. */
export function applySkills(basePrompt: string, mandatory: string[], registry: SkillRegistry): string {
  const parts: string[] = [basePrompt];

  if (mandatory.length) {
    const sections = mandatory.map((name) => {
      const skill = registry.get(name);
      if (!skill) throw new Error(`applySkills: undefined skill: ${name}`);
      // A script-driven skill needs its own path to be usable at all: its instructions say things like
      // "run node <skill-base-dir>/scripts/context.mjs", which is meaningless unless we say where it is.
      const where = skill.dir ? `\n_Skill base directory: ${skill.dir}_\n` : "";
      return `## ${skill.name}${where}\n${skill.content}`;
    });
    parts.push(`# Mandatory Skills\n${sections.join("\n\n")}`);
  }

  const mandatorySet = new Set(mandatory);
  const available = registry.list().filter((s) => !mandatorySet.has(s.name));
  if (available.length) {
    const lines = available.map((s) => `- ${s.name}: ${s.description}`);
    parts.push(`# Discoverable Skills (call the skill tool to fetch its content)\n${lines.join("\n")}`);
  }

  return parts.join("\n\n");
}

const skillParams = z.object({
  name: z.string(),
  /** A supporting document inside the skill's own directory, e.g. "reference/critique.md". */
  file: z.string().optional(),
});

/** Cap on one supporting document (~7.5k tokens) — the same reasoning as read_file's. */
export const MAX_SKILL_DOC_CHARS = 30_000;

/**
 * A "skill" tool that fetches a skill's content by name, and — for skills that are DISPATCHERS — any of its
 * supporting documents by relative path.
 *
 * Reading those on demand is the whole point: a dispatcher's SKILL.md is small enough to sit in a prompt,
 * while its reference tree can run to megabytes. Inlining the tree would cost far more on every single call
 * than the guidance is worth on the rare call that needs it.
 */
export function buildSkillTool(registry: SkillRegistry): Tool {
  return {
    name: "skill",
    description:
      "Fetch a skill's content by name. Some skills are dispatchers whose SKILL.md points at supporting " +
      "documents (e.g. \"see reference/critique.md\"); pass `file` with that relative path to read one. " +
      "Fetch a document only when the skill actually sends you to it.",
    permissionLevel: "safe",
    parameters: skillParams,
    run: async (rawArgs) => {
      const parsed = skillParams.safeParse(rawArgs);
      if (!parsed.success) {
        return { content: `skill: invalid args: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
      }
      const { name, file } = parsed.data;
      const skill = registry.get(name);
      if (!skill) return { content: `skill not found: ${name}`, isError: true };
      if (file === undefined) {
        const where = skill.dir ? `_Skill base directory: ${skill.dir}_\n\n` : "";
        return { content: `${where}${skill.content}`, isError: false };
      }
      if (!skill.dir) return { content: `skill ${name}: has no supporting documents`, isError: true };

      // Containment: a supporting document must live INSIDE the skill's directory. Without this check the
      // path is a read-anything primitive dressed up as a skill lookup.
      const target = resolve(skill.dir, file);
      const root = resolve(skill.dir);
      if (target !== root && !target.startsWith(root + sep)) {
        return { content: `skill ${name}: ${file} is outside the skill directory`, isError: true };
      }
      let raw: string;
      try {
        raw = await readFile(target, "utf8");
      } catch {
        return { content: `skill ${name}: no such document: ${file}`, isError: true };
      }
      if (raw.length <= MAX_SKILL_DOC_CHARS) return { content: raw, isError: false };
      return {
        content: `${raw.slice(0, MAX_SKILL_DOC_CHARS)}\n\n[skill ${name}/${file}: truncated at ${MAX_SKILL_DOC_CHARS} of ${raw.length} chars]`,
        isError: false,
      };
    },
  };
}
