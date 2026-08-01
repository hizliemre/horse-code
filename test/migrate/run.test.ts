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
  ask: async () => "Yes — copy all", // every question, including the removal one
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
/**
 * horse-code reads `.horsecode/skills`, so a skill left at its old path is not a second source — it is a
 * stale twin that will drift the moment either copy is edited, with nothing to say which one an agent read.
 */
describe("the originals are removed once their copy is in place", () => {
  /** Answers yes to the copy, and whatever `remove` says to the removal question. */
  const asker = (remove: string) => async (q: string) => (q.includes("Remove the originals") ? remove : "Yes — copy all");

  it("deletes the old directory after copying it", async () => {
    await put(cwd, ".claude/skills/impeccable/SKILL.md", "---\nname: impeccable\ndescription: d\n---\nbody");
    await put(cwd, ".claude/skills/impeccable/reference/craft.md", "the craft flow");

    const r = await runMigration(deps({ ask: asker("Yes — remove the originals") }));

    expect(existsSync(join(cwd, ".horsecode", "skills", "impeccable", "reference", "craft.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude", "skills", "impeccable"))).toBe(false);
    expect(r.removed).toBeGreaterThan(0);
  });

  it("removes a symlink AND what it points at — the link alone leaves the duplicate behind", async () => {
    const { symlink } = await import("node:fs/promises");
    await put(cwd, ".agents/skills/brandkit/SKILL.md", "---\nname: brandkit\ndescription: d\n---\nbody");
    await mkdir(join(cwd, ".claude", "skills"), { recursive: true });
    await symlink(join(cwd, ".agents", "skills", "brandkit"), join(cwd, ".claude", "skills", "brandkit"));

    await runMigration(deps({ ask: asker("Yes — remove the originals") }));

    expect(existsSync(join(cwd, ".horsecode", "skills", "brandkit", "SKILL.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude", "skills", "brandkit"))).toBe(false);
    expect(existsSync(join(cwd, ".agents", "skills", "brandkit"))).toBe(false); // the real content, not just the link
  });

  it("keeps them when the user says no", async () => {
    await put(cwd, ".claude/skills/impeccable/SKILL.md", "---\nname: impeccable\ndescription: d\n---\nbody");
    const r = await runMigration(deps({ ask: asker("No — keep them") }));
    expect(existsSync(join(cwd, ".claude", "skills", "impeccable"))).toBe(true);
    expect(r.removed).toBe(0);
    expect(r.declined).toContain("removing the originals");
  });

  /**
   * A skill horse-code already ships was deliberately NOT copied — deleting it would remove the only copy of
   * this project's variant of it, which is the user's call to make by hand.
   */
  it("never deletes a skill it did not copy", async () => {
    await put(cwd, ".claude/skills/impeccable/SKILL.md", "---\nname: impeccable\ndescription: d\n---\nours");
    await put(cwd, ".claude/skills/brandkit/SKILL.md", "---\nname: brandkit\ndescription: d\n---\nbody");

    const r = await runMigration(deps({ existingSkills: () => ["impeccable"], ask: asker("Yes — remove the originals") }));

    expect(r.skills).toBe(1);
    expect(existsSync(join(cwd, ".claude", "skills", "brandkit"))).toBe(false);   // copied → removed
    expect(existsSync(join(cwd, ".claude", "skills", "impeccable"))).toBe(true);  // not copied → untouched
  });
});

describe("the summary does not claim more than happened", () => {
  it("says so when batches failed, and still lists what did land", async () => {
    const { describeResult } = await import("../../src/migrate/run.js");
    const out = describeResult({ rules: 0, facts: 0, skills: 73, skipped: 0, declined: [], failedBatches: 24, removed: 0 });
    expect(out).toContain("finished with failures");
    expect(out).toContain("24 batch(es) failed to read");
    expect(out).toContain("73 skill(s)");
    expect(out).not.toContain("Migration complete");
  });

  it("still reads as complete when nothing failed", async () => {
    const { describeResult } = await import("../../src/migrate/run.js");
    const out = describeResult({ rules: 3, facts: 9, skills: 1, skipped: 2, declined: [], failedBatches: 0, removed: 0 });
    expect(out).toContain("Migration complete");
    expect(out).not.toContain("failed to read");
  });
});

/**
 * Migration's long stretches were silent: "Reading 223 file(s)…" was printed once and the next word arrived
 * only when every batch had finished — minutes later, with nothing in between to say whether it was working,
 * stuck, or how far along it was.
 */
describe("the user can see what is happening", () => {
  const withFeedback = async (over: Partial<Parameters<typeof runMigration>[0]> = {}) => {
    const lines: { phase: string; text: string }[] = [];
    const phases: string[] = [];
    await runMigration(deps({
      progress: (phase, text) => lines.push({ phase, text }),
      busy: (phase) => phases.push(`busy:${phase}`),
      idle: () => phases.push("idle"),
      ...over,
    }));
    return { lines, phases };
  };

  it("reports every batch as it lands — the stretch that used to be silent for minutes", async () => {
    const ITEMS = '```json\n{"items":[{"text":"Always write in English","disposition":"rule","reason":"r"}]}\n```';
    const answering = { async *chat() { yield { type: "text-delta" as const, text: ITEMS }; } } as unknown as Provider;
    // Two rule files → two batches, so the line must count 1/2 then 2/2 rather than appear once at the end.
    await put(cwd, "CLAUDE.md", "# rules\nalways write in english");
    await put(cwd, "DESIGN.md", "# tokens\nnever use a raw hex value");

    const { lines, phases } = await withFeedback({ provider: answering, ask: async () => "No" });

    const read = lines.filter((l) => l.phase === "read");
    expect(read).toHaveLength(2);
    expect(read[0]!.text).toContain("1/2");
    expect(read[1]!.text).toContain("2/2");
    expect(read[0]!.text).toContain("CLAUDE.md"); // says WHICH file, not just a number
    expect(phases.slice(0, 2)).toEqual(["busy:reading instructions", "idle"]);
  });

  it("counts the skills up as they are copied, on one rewritable line", async () => {
    for (const n of ["a", "b", "c"]) {
      await put(cwd, `.claude/skills/${n}/SKILL.md`, `---\nname: ${n}\ndescription: d\n---\nbody`);
    }
    const { lines } = await withFeedback({ ask: async (q: string) => (q.includes("Remove the originals") ? "No" : "Yes") });
    const copy = lines.filter((l) => l.phase === "copy");
    expect(copy).toHaveLength(3);
    expect(copy[0]!.text).toContain("1/3");
    expect(copy[2]!.text).toContain("3/3");
  });

  it("counts the removals too", async () => {
    await put(cwd, ".claude/skills/a/SKILL.md", "---\nname: a\ndescription: d\n---\nbody");
    const { lines } = await withFeedback({ ask: async () => "Yes" });
    expect(lines.filter((l) => l.phase === "remove")).toHaveLength(1);
  });

  it("enters and leaves the running state around the model call that assigns skills", async () => {
    await put(cwd, ".claude/skills/a/SKILL.md", "---\nname: a\ndescription: d\n---\nbody");
    const { phases } = await withFeedback({
      ask: async (q: string) => (q.includes("Remove the originals") ? "No" : "Yes"),
      assignSkills: async () => "assigned",
    });
    expect(phases).toEqual(["busy:assigning skills", "idle"]);
  });

  it("leaves the running state even when the assignment throws", async () => {
    await put(cwd, ".claude/skills/a/SKILL.md", "---\nname: a\ndescription: d\n---\nbody");
    const { phases } = await withFeedback({
      ask: async (q: string) => (q.includes("Remove the originals") ? "No" : "Yes"),
      assignSkills: async () => { throw new Error("quota"); },
    });
    expect(phases).toEqual(["busy:assigning skills", "idle"]); // never left shimmering forever
  });
});
