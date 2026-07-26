import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry } from "../../src/skills/registry.js";
import { buildSkillTool, MAX_SKILL_DOC_CHARS } from "../../src/skills/apply.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-disp-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const ctx = () => ({ cwd: dir, signal: new AbortController().signal });

/** A DISPATCHER skill: a small SKILL.md that routes to sibling reference documents. */
async function dispatcher(): Promise<SkillRegistry> {
  await mkdir(join(dir, "impeccable", "reference"), { recursive: true });
  await writeFile(join(dir, "impeccable", "SKILL.md"),
    "---\nname: impeccable\ndescription: design polish\n---\nSee reference/critique.md for the checklist.", "utf8");
  await writeFile(join(dir, "impeccable", "reference", "critique.md"), "THE CRITIQUE CHECKLIST", "utf8");
  const r = new SkillRegistry();
  await r.loadFromDir(dir);
  return r;
}

describe("dispatcher skills — supporting documents are fetched on demand", () => {
  it("without `file` it still returns the entry point, as before", async () => {
    const tool = buildSkillTool(await dispatcher());
    const res = await tool.run({ name: "impeccable" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.content).toContain("See reference/critique.md");
  });

  // The point: a dispatcher's SKILL.md is small enough to sit in a prompt while its reference tree can run to
  // megabytes. The tree is read only on the rare call that needs it.
  it("`file` reads a supporting document by its relative path", async () => {
    const tool = buildSkillTool(await dispatcher());
    const res = await tool.run({ name: "impeccable", file: "reference/critique.md" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.content).toBe("THE CRITIQUE CHECKLIST");
  });

  // Without containment this parameter is a read-anything primitive dressed up as a skill lookup.
  it("refuses to escape the skill's directory", async () => {
    await writeFile(join(dir, "secret.txt"), "TOP SECRET", "utf8");
    const tool = buildSkillTool(await dispatcher());
    for (const file of ["../secret.txt", "../../etc/passwd", "reference/../../secret.txt"]) {
      const res = await tool.run({ name: "impeccable", file }, ctx());
      expect(res.isError).toBe(true);
      expect(res.content).toMatch(/outside the skill directory/);
    }
  });

  it("refuses an absolute path", async () => {
    const tool = buildSkillTool(await dispatcher());
    const res = await tool.run({ name: "impeccable", file: "/etc/passwd" }, ctx());
    expect(res.isError).toBe(true);
  });

  it("reports a missing document rather than failing silently", async () => {
    const tool = buildSkillTool(await dispatcher());
    const res = await tool.run({ name: "impeccable", file: "reference/nope.md" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/no such document/);
  });

  it("says so when a skill has no directory at all", async () => {
    const r = new SkillRegistry();
    r.register({ name: "inline", description: "d", content: "body" });
    const res = await buildSkillTool(r).run({ name: "inline", file: "x.md" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/no supporting documents/);
  });

  it("truncates an oversized document and says where it stopped", async () => {
    const r = await dispatcher();
    await writeFile(join(dir, "impeccable", "reference", "huge.md"), "x".repeat(MAX_SKILL_DOC_CHARS * 2), "utf8");
    const res = await buildSkillTool(r).run({ name: "impeccable", file: "reference/huge.md" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.content.length).toBeLessThan(MAX_SKILL_DOC_CHARS + 200);
    expect(res.content).toMatch(/truncated at/);
  });

  it("an unknown skill is still an error", async () => {
    const res = await buildSkillTool(await dispatcher()).run({ name: "nope" }, ctx());
    expect(res.isError).toBe(true);
  });

  it("the tool tells the model that supporting documents exist", () => {
    const d = buildSkillTool(new SkillRegistry()).description;
    expect(d).toMatch(/dispatcher/i);
    expect(d).toMatch(/only when the skill actually sends you to it/i);
  });
});
