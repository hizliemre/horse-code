import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

export interface Skill {
  name: string;
  description: string;
  content: string;
}

export class SkillRegistry {
  private skills = new Map<string, Skill>();

  register(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  list(): { name: string; description: string }[] {
    return [...this.skills.values()].map((s) => ({ name: s.name, description: s.description }));
  }

  async loadFromDir(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // dir doesn't exist → skills are optional, return silently
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      let raw: string;
      try {
        raw = await readFile(join(dir, e.name, "SKILL.md"), "utf8");
      } catch {
        continue; // no SKILL.md → not a skill directory, skip
      }
      const { name, description, body } = parseFrontmatter(raw);
      if (!name || !description) {
        throw new Error(`skill ${e.name}: missing frontmatter (name/description)`);
      }
      this.register({ name, description, content: body });
    }
  }
}
