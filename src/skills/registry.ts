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
}
