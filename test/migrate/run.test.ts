import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigration } from "../../src/migrate/run.js";
import { MemoryStore } from "../../src/session/memory.js";
import type { Provider } from "../../src/core/types.js";

let cwd: string;
let home: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "hc-mig-proj-"));
  home = await mkdtemp(join(tmpdir(), "hc-mig-home-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const put = async (base: string, file: string, body: string): Promise<void> => {
  await mkdir(join(base, file, ".."), { recursive: true });
  await writeFile(join(base, file), body, "utf8");
};

/** No prose findings in these tests, so the classifier is never called. */
const provider = { async *chat() { throw new Error("provider must not be used"); } } as unknown as Provider;

const deps = (over: Partial<Parameters<typeof runMigration>[0]> = {}) => ({
  cwd, home, provider, models: ["m"],
  memStore: new MemoryStore({ home, cwd }),
  ask: async () => "Yes — copy all",
  note: () => {},
  ...over,
});

/**
 * Good skills are DISPATCHERS: a short SKILL.md routing to sibling documents ("read reference/craft.md").
 * horse-code supports that — the registry keeps each skill's directory and reads references on demand — so
 * copying only the entry point produced a skill whose every instruction pointed at a file that was not there.
 */
describe("migrating a skill brings its whole tree", () => {
  it("copies reference documents and scripts, not just SKILL.md", async () => {
    await put(cwd, ".claude/skills/impeccable/SKILL.md", "---\nname: impeccable\ndescription: d\n---\nread reference/craft.md");
    await put(cwd, ".claude/skills/impeccable/reference/craft.md", "the craft flow");
    await put(cwd, ".claude/skills/impeccable/scripts/context.mjs", "console.log(1)");

    const r = await runMigration(deps());

    expect(r.skills).toBe(1);
    const dest = join(cwd, ".horsecode", "skills", "impeccable");
    expect(await readFile(join(dest, "SKILL.md"), "utf8")).toContain("reference/craft.md");
    expect(await readFile(join(dest, "reference", "craft.md"), "utf8")).toBe("the craft flow");
    expect(existsSync(join(dest, "scripts", "context.mjs"))).toBe(true);
  });

  it("resolves a symlinked skill rather than landing a dangling link", async () => {
    const { symlink } = await import("node:fs/promises");
    await put(cwd, ".agents/skills/brandkit/SKILL.md", "---\nname: brandkit\ndescription: d\n---\nbody");
    await put(cwd, ".agents/skills/brandkit/reference/tone.md", "the tone");
    await mkdir(join(cwd, ".claude", "skills"), { recursive: true });
    await symlink(join(cwd, ".agents", "skills", "brandkit"), join(cwd, ".claude", "skills", "brandkit"));

    await runMigration(deps());

    // Copied through the link: the file must be readable at the destination even if the source moves.
    expect(await readFile(join(cwd, ".horsecode", "skills", "brandkit", "reference", "tone.md"), "utf8")).toBe("the tone");
  });

  it("leaves the skills where they are when the user declines", async () => {
    await put(cwd, ".claude/skills/impeccable/SKILL.md", "---\nname: impeccable\ndescription: d\n---\nbody");
    const r = await runMigration(deps({ ask: async () => "No" }));
    expect(r.skills).toBe(0);
    expect(r.declined).toContain("skills");
    expect(existsSync(join(cwd, ".horsecode", "skills", "impeccable"))).toBe(false);
  });

  it("does not shadow a skill horse-code already ships", async () => {
    await put(cwd, ".claude/skills/impeccable/SKILL.md", "---\nname: impeccable\ndescription: d\n---\nbody");
    const r = await runMigration(deps({ existingSkills: () => ["impeccable"] }));
    expect(r.skills).toBe(0);
    expect(existsSync(join(cwd, ".horsecode", "skills", "impeccable"))).toBe(false);
  });
});

/**
 * A run where every batch died on an exhausted quota imported nothing but skills and still signed off with
 * **Migration complete** — with the 219 remembered facts it had silently dropped nowhere in the summary.
 */
describe("the summary does not claim more than happened", () => {
  it("says so when batches failed, and still lists what did land", async () => {
    const { describeResult } = await import("../../src/migrate/run.js");
    const out = describeResult({ rules: 0, facts: 0, skills: 73, skipped: 0, declined: [], failedBatches: 24 });
    expect(out).toContain("finished with failures");
    expect(out).toContain("24 batch(es) failed to read");
    expect(out).toContain("73 skill(s)");
    expect(out).not.toContain("Migration complete");
  });

  it("still reads as complete when nothing failed", async () => {
    const { describeResult } = await import("../../src/migrate/run.js");
    const out = describeResult({ rules: 3, facts: 9, skills: 1, skipped: 2, declined: [], failedBatches: 0 });
    expect(out).toContain("Migration complete");
    expect(out).not.toContain("failed to read");
  });
});
