import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordMigrated, loadMigrated, loadMigratedSync, isMigrated, migratedNotice,
} from "../../src/migrate/migrated.js";
import { readFileTool } from "../../src/tools/read.js";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "mig-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

const ctx = (): { cwd: string; signal: AbortSignal } => ({ cwd, signal: new AbortController().signal });

describe("a migrated rule file no longer speaks for the project", () => {
  /**
   * Nothing ever injected `CLAUDE.md` — but nothing prevented a role from reading it either, and every role
   * has `read_file`. After migration its rules are in memory, so the file on disk is a second copy that
   * stopped moving on the day it was read: an agent that opens it gets the rules AS THEY WERE and trusts
   * them over the memory it was given, silently.
   */
  it("answers a read with where the rules went, not with the file's text", async () => {
    await writeFile(join(cwd, "CLAUDE.md"), "# Old rules\nAlways use tabs.\n", "utf8");
    await recordMigrated(cwd, ["CLAUDE.md"], Date.parse("2026-08-01T00:00:00Z"));

    const res = await readFileTool.run({ path: "CLAUDE.md" }, ctx() as never);
    expect(res.isError).toBe(false);
    expect(res.content).not.toContain("Always use tabs");     // the stale rules never reach the model
    expect(res.content).toContain("migrated into this project's memory");
    expect(res.content).toContain("2026-08-01");              // …and says WHEN they moved
  });

  it("still reads every other file normally", async () => {
    await writeFile(join(cwd, "CLAUDE.md"), "old", "utf8");
    await writeFile(join(cwd, "README.md"), "the readme", "utf8");
    await recordMigrated(cwd, ["CLAUDE.md"]);
    const res = await readFileTool.run({ path: "README.md" }, ctx() as never);
    expect(res.content).toContain("the readme");
  });

  it("reads normally when nothing was migrated — the guard is opt-in by construction", async () => {
    await writeFile(join(cwd, "CLAUDE.md"), "still the source of truth here", "utf8");
    const res = await readFileTool.run({ path: "CLAUDE.md" }, ctx() as never);
    expect(res.content).toContain("still the source of truth here");
  });

  it("matches the path however the agent writes it", async () => {
    const rec = { version: 1 as const, at: 0, files: ["CLAUDE.md", ".github/copilot-instructions.md"] };
    expect(isMigrated(rec, "CLAUDE.md")).toBe(true);
    expect(isMigrated(rec, "./CLAUDE.md")).toBe(true);
    expect(isMigrated(rec, "/Users/x/project/CLAUDE.md")).toBe(true);
    expect(isMigrated(rec, ".github/copilot-instructions.md")).toBe(true);
    // …and does not swallow a different file that merely ends similarly.
    expect(isMigrated(rec, "docs/NOT-CLAUDE.md")).toBe(false);
    expect(isMigrated(undefined, "CLAUDE.md")).toBe(false);
  });

  it("tells the agent what to do instead of only what it may not have", () => {
    const notice = migratedNotice("CLAUDE.md", { version: 1, at: 0, files: ["CLAUDE.md"] });
    expect(notice).toMatch(/memory/i);                  // where the rules are
    expect(notice).toMatch(/ask them to confirm/i);     // and the way out, if the user really means it
  });
});

describe("what may be marked migrated at all", () => {
  /**
   * Caught in a real run: the record came back as CLAUDE.md, DESIGN.md, PRODUCT.md. The last two sit in the
   * rules table because they ARE instruction material — but they belong to the project, the team edits them,
   * and they stay the living source. Marking them migrated would answer an agent looking for the design
   * tokens with "the rules moved to memory" while the file was still the truth: a worse failure than the
   * stale one the mechanism exists to prevent.
   */
  it("marks another tool's prompt, never the project's own documents", async () => {
    const { discover } = await import("../../src/migrate/discover.js");
    await writeFile(join(cwd, "CLAUDE.md"), "# other tool's rules", "utf8");
    await writeFile(join(cwd, "DESIGN.md"), "# our design tokens", "utf8");
    await writeFile(join(cwd, "PRODUCT.md"), "# our product", "utf8");

    const found = await discover({ cwd, home: join(cwd, "nohome") });
    const rules = found.filter((f) => f.kind === "rules");
    const byLabel = new Map(rules.map((f) => [f.label, f]));
    expect(byLabel.get("CLAUDE.md")?.own).toBeFalsy();   // another tool's → may be superseded
    expect(byLabel.get("DESIGN.md")?.own).toBe(true);    // ours → never
    expect(byLabel.get("PRODUCT.md")?.own).toBe(true);
  });
});

describe("the record itself", () => {
  it("merges across migrations instead of replacing", async () => {
    await recordMigrated(cwd, ["CLAUDE.md"]);
    await recordMigrated(cwd, ["AGENTS.md", "CLAUDE.md"]);
    expect((await loadMigrated(cwd))?.files).toEqual(["AGENTS.md", "CLAUDE.md"]);
  });

  it("writes nothing when there is nothing to record", async () => {
    await recordMigrated(cwd, []);
    expect(await loadMigrated(cwd)).toBeUndefined();
  });

  it("survives a corrupt file rather than taking the run down with it", async () => {
    await mkdir(join(cwd, ".horsecode"), { recursive: true });
    await writeFile(join(cwd, ".horsecode", "migrated.json"), "{ not json", "utf8");
    expect(await loadMigrated(cwd)).toBeUndefined();
    expect(loadMigratedSync(cwd, (p) => readFileSync(p, "utf8"))).toBeUndefined();
  });
});
