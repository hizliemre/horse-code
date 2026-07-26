import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillRegistry } from "./registry.js";

/**
 * Skills that ship WITH horse-code, from the repo's top-level `skills/` directory.
 *
 * They use exactly the same format and registry as a project's own `.horsecode/skills` — the only difference
 * is who supplies them. Loaded FIRST so a project can override any of them by defining a skill of the same
 * name; the registry is keyed by name and the later registration wins.
 *
 * Absent skills are not an error. A checkout without the directory (or a packaging mistake) must degrade to
 * "no built-in skills", never to a crash on startup: skills are additive guidance, not machinery.
 */

/** Candidate locations for the bundled `skills/` dir, relative to this module's location at runtime. */
function candidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(here, "..", "skills"),        // bundled: dist/… → <repo>/skills
    resolve(here, "..", "..", "skills"),  // source: src/skills/… → <repo>/skills
    resolve(here, "..", "..", "..", "skills"),
  ];
}

/** Registers every built-in skill it can find. Returns how many were loaded. */
export async function registerBuiltinSkills(registry: SkillRegistry, dirs = candidates()): Promise<number> {
  for (const dir of dirs) {
    try {
      // Only a directory that actually holds skill folders counts — an unrelated `skills` dir higher up the
      // tree must not be adopted just because the path resolved.
      const entries = await readdir(dir, { withFileTypes: true });
      const found: { name: string; description: string; content: string; dir: string }[] = [];
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        let raw: string;
        try { raw = await readFile(join(dir, e.name, "SKILL.md"), "utf8"); } catch { continue; }
        const { parseFrontmatter } = await import("./frontmatter.js");
        const { name, description, body } = parseFrontmatter(raw);
        if (!name || !description) continue; // a malformed built-in is skipped, never fatal
        found.push({ name, description, content: body, dir: join(dir, e.name) });
      }
      if (!found.length) continue;
      for (const s of found) registry.register(s);
      return found.length;
    } catch {
      continue; // not this location → try the next
    }
  }
  return 0;
}
