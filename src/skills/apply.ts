import { z } from "zod";
import type { Tool } from "../core/types.js";
import type { SkillRegistry } from "./registry.js";

/** basePrompt'a zorunlu skill içeriklerini ve keşfedilebilir listing'i ekler. */
export function applySkills(basePrompt: string, mandatory: string[], registry: SkillRegistry): string {
  const parts: string[] = [basePrompt];

  if (mandatory.length) {
    const sections = mandatory.map((name) => {
      const skill = registry.get(name);
      if (!skill) throw new Error(`applySkills: tanımsız skill: ${name}`);
      return `## ${skill.name}\n${skill.content}`;
    });
    parts.push(`# Zorunlu Skill'ler\n${sections.join("\n\n")}`);
  }

  const available = registry.list();
  if (available.length) {
    const lines = available.map((s) => `- ${s.name}: ${s.description}`);
    parts.push(`# Keşfedilebilir Skill'ler (skill tool ile içeriğini çağır)\n${lines.join("\n")}`);
  }

  return parts.join("\n\n");
}

const skillParams = z.object({ name: z.string() });

/** Bir skill'in içeriğini adıyla getiren "skill" tool'u (çağıran toolset'e ekler). */
export function buildSkillTool(registry: SkillRegistry): Tool {
  return {
    name: "skill",
    description: "Bir skill'in tam içeriğini adıyla getir.",
    permissionLevel: "safe",
    parameters: skillParams,
    run: async (rawArgs) => {
      const parsed = skillParams.safeParse(rawArgs);
      if (!parsed.success) {
        return { content: `skill: geçersiz args: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
      }
      const skill = registry.get(parsed.data.name);
      if (!skill) return { content: `skill bulunamadı: ${parsed.data.name}`, isError: true };
      return { content: skill.content, isError: false };
    },
  };
}
