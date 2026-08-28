import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SkillRegistry } from "../../src/skills/registry.js";
import { registerBuiltinSkills } from "../../src/skills/builtin.js";

const root = new URL("../../", import.meta.url).pathname;

/**
 * The built-in skills have to be IN the package, and only the manifest decides that.
 *
 * `files` was `["dist"]`, so 0.1.0 shipped without `skills/` — an install from the registry had five fewer
 * built-in skills than a checkout, and said nothing about it. That silence is deliberate elsewhere: a
 * missing skills directory degrades to "no built-in skills" rather than crashing on startup, because
 * skills are guidance and not machinery. The cost of that choice is that packaging them away looks
 * exactly like having none, so the manifest is what has to be asserted.
 */
describe("what the published package contains", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files: string[] };

  it("ships the skills directory, not only dist", () => {
    expect(pkg.files).toContain("skills");
  });

  it("has skills to ship in the first place", async () => {
    const dirs = readdirSync(join(root, "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(root, "skills", e.name, "SKILL.md")));
    expect(dirs.length).toBeGreaterThan(0);

    // …and they load. A directory full of files the loader rejects would pass the check above.
    const registry = new SkillRegistry();
    const loaded = await registerBuiltinSkills(registry);
    expect(loaded).toBe(dirs.length);
  });

  /**
   * `dist/` is where the loader looks from when installed: `dist/… → ../skills`. If the build output ever
   * moves, that relative walk moves with it, and this pairing is the thing that must stay true.
   */
  it("keeps the bin and the built output in the files list", () => {
    expect(pkg.files).toContain("dist");
  });
});
