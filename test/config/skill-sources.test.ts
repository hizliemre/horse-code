import { describe, it, expect } from "vitest";
import { loadConfig, DEFAULT_CONFIG } from "../../src/config/config.js";

const at = (files: Record<string, unknown>) => (p: string): string | undefined =>
  files[p] === undefined ? undefined : JSON.stringify(files[p]);

const GLOBAL = "/home/.horsecode/config.json";
const PROJECT = "/proj/.horsecode/config.json";
const load = (files: Record<string, unknown>) =>
  loadConfig({ cwd: "/proj", home: "/home", env: {}, readFile: at(files) });

const names = (files: Record<string, unknown>): string[] => load(files).skillSources.map((s) => s.name);

/**
 * `impeccable` ships as a REFERENCE rather than a copy — 3.3 MB across 154 files, carrying its own scripts
 * and maintained upstream. skills/README.md describes exactly this shape, and vendoring it would freeze it
 * at one commit while multiplying the published package by ten.
 *
 * A default nobody can turn off is a worse deal than no default, so the rule is the one saveRoleSkills
 * already uses for role skills: a STATED list is the user's word, an ABSENT one has never been spoken
 * about and falls back.
 */
describe("shipped skill sources", () => {
  it("gives a config that has never mentioned skill sources the shipped ones", () => {
    expect(names({})).toEqual(["impeccable"]);
    expect(DEFAULT_CONFIG.skillSources.map((s) => s.name)).toEqual(["impeccable"]);
  });

  it("ships it as a repo reference, never as a local copy", () => {
    const [src] = load({}).skillSources;
    expect(src).toMatchObject({ name: "impeccable", repo: "pbakaus/impeccable", path: ".agents/skills/impeccable" });
  });

  /** The opt-out. An empty list is a sentence, not a silence. */
  it("takes an explicitly empty list as the answer and adds nothing back", () => {
    expect(names({ [GLOBAL]: { skillSources: [] } })).toEqual([]);
    expect(names({ [PROJECT]: { skillSources: [] } })).toEqual([]);
  });

  it("lets a stated list replace the shipped one entirely", () => {
    expect(names({ [GLOBAL]: { skillSources: [{ name: "mine", repo: "me/mine" }] } })).toEqual(["mine"]);
  });

  it("lets a project pin a different ref for a source the machine already has", () => {
    const cfg = load({
      [GLOBAL]: { skillSources: [{ name: "impeccable", repo: "pbakaus/impeccable" }] },
      [PROJECT]: { skillSources: [{ name: "impeccable", repo: "pbakaus/impeccable", ref: "v4" }] },
    });
    expect(cfg.skillSources).toHaveLength(1);
    expect(cfg.skillSources[0]?.ref).toBe("v4");
  });

  /**
   * Stating a list in ONE config is enough to have spoken. Otherwise a project that adds a source of its own
   * would silently inherit the shipped one it never asked for, on top of a global list that had already
   * excluded it.
   */
  it("counts a list stated in either file as having been spoken", () => {
    expect(names({ [PROJECT]: { skillSources: [{ name: "mine", repo: "me/mine" }] } })).toEqual(["mine"]);
    expect(names({ [GLOBAL]: { skillSources: [] }, [PROJECT]: { skillSources: [{ name: "mine", repo: "me/mine" }] } }))
      .toEqual(["mine"]);
  });
});
