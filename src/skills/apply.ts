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
      return `## ${skill.name}\n${skill.content}`;
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

const skillParams = z.object({ name: z.string() });

/** A "skill" tool that fetches a skill's content by name (add to the caller's toolset). */
export function buildSkillTool(registry: SkillRegistry): Tool {
  return {
    name: "skill",
    description: "Fetch the full content of a skill by its name.",
    permissionLevel: "safe",
    parameters: skillParams,
    run: async (rawArgs) => {
      const parsed = skillParams.safeParse(rawArgs);
      if (!parsed.success) {
        return { content: `skill: invalid args: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
      }
      const skill = registry.get(parsed.data.name);
      if (!skill) return { content: `skill not found: ${parsed.data.name}`, isError: true };
      return { content: skill.content, isError: false };
    },
  };
}
