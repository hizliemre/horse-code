import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover, summarize, hasAnything, claudeProjectSlug, MAX_FINDING_BYTES } from "../../src/migrate/discover.js";

let cwd: string;
let home: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "hc-proj-"));
  home = await mkdtemp(join(tmpdir(), "hc-home-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const put = async (base: string, file: string, body = "content"): Promise<void> => {
  await mkdir(join(base, file, ".."), { recursive: true });
  await writeFile(join(base, file), body, "utf8");
};

const find = () => discover({ cwd, home });

describe("claudeProjectSlug", () => {
  /** Claude Code keys its per-project directory by the absolute path with separators replaced. */
  it("mirrors the exact mapping rather than guessing by basename", () => {
    expect(claudeProjectSlug("/Users/x/Desktop/app")).toBe("-Users-x-Desktop-app");
  });
});

describe("discover — rule files", () => {
  it.each([
    ["CLAUDE.md", "Claude Code"],
    ["AGENTS.md", "Codex / OpenAI"],
    [".cursorrules", "Cursor"],
    ["GEMINI.md", "Gemini CLI"],
    [".windsurfrules", "Windsurf"],
    [".github/copilot-instructions.md", "GitHub Copilot"],
  ])("finds %s and names the tool that wrote it", async (file, tool) => {
    await put(cwd, file);
    const got = (await find()).find((f) => f.label === file);
    expect(got?.kind).toBe("rules");
    expect(got?.tool).toBe(tool);
  });

  it("finds rule fragments in a rules directory", async () => {
    await put(cwd, ".cursor/rules/style.mdc");
    expect((await find()).some((f) => f.label === ".cursor/rules/style.mdc")).toBe(true);
  });

  /**
   * The user-level file holds standing preferences ("never write in language X") — exactly the kind of thing
   * that is lost in a move and noticed only much later.
   */
  it("finds the user-level instruction file, not just the project one", async () => {
    await put(home, ".claude/CLAUDE.md");
    expect((await find()).some((f) => f.label === "~/.claude/CLAUDE.md")).toBe(true);
  });

  it("ignores an empty file", async () => {
    await put(cwd, "CLAUDE.md", "");
    expect(await find()).toEqual([]);
  });

  // Reported so the user knows it exists, but not read into a prompt.
  it("reports an oversized file without reading it", async () => {
    await put(cwd, "CLAUDE.md", "x".repeat(MAX_FINDING_BYTES + 1));
    const got = (await find())[0];
    expect(got.bytes).toBeGreaterThan(MAX_FINDING_BYTES);
    expect(got.text).toBeUndefined();
  });
});

describe("discover — memory, skills, config", () => {
  const memDir = (): string => join(".claude", "projects", claudeProjectSlug(cwd), "memory");

  it("finds remembered facts under the project's own memory directory", async () => {
    await put(home, join(memDir(), "feedback_always_ask.md"), "---\nname: x\n---\nbody");
    const got = (await find()).filter((f) => f.kind === "memory");
    expect(got).toHaveLength(1);
    expect(got[0].label).toBe("memory/feedback_always_ask.md");
  });

  /** MEMORY.md is an index of the others; importing it would duplicate every entry as a list. */
  it("skips the memory index", async () => {
    await put(home, join(memDir(), "MEMORY.md"), "# index");
    expect((await find()).filter((f) => f.kind === "memory")).toEqual([]);
  });

  it("finds skills by their directory, since that is what names them", async () => {
    await put(cwd, ".claude/skills/accessibility/SKILL.md", "---\nname: accessibility\n---\nbody");
    const got = (await find()).find((f) => f.kind === "skill");
    expect(got?.label).toBe(".claude/skills/accessibility");
  });

  /** Configuration transfers exactly; losing it silently breaks tools the project depends on. */
  it.each([".mcp.json", ".cursor/mcp.json", ".claude/settings.json"])("finds %s", async (file) => {
    await put(cwd, file, "{}");
    expect((await find()).some((f) => f.kind === "mcp" && f.label === file)).toBe(true);
  });

  // A different shape from ours — the user should know they exist rather than find the gap later.
  it("reports subagents and slash commands", async () => {
    await put(cwd, ".claude/agents/reviewer.md");
    await put(cwd, ".claude/commands/deploy.md");
    const got = await find();
    expect(got.some((f) => f.kind === "agent")).toBe(true);
    expect(got.some((f) => f.kind === "command")).toBe(true);
  });
});

describe("discover — robustness", () => {
  it("a project with nothing to migrate is not an error", async () => {
    expect(await find()).toEqual([]);
    expect(hasAnything([])).toBe(false);
  });

  it("does not treat subagents alone as something worth migrating", async () => {
    await put(cwd, ".claude/agents/x.md");
    expect(hasAnything(await find())).toBe(false);
  });

  it("a missing home directory is not an error", async () => {
    expect(await discover({ cwd, home: "/nowhere-at-all" })).toEqual([]);
  });
});

describe("summarize", () => {
  it("says plainly when there is nothing", () => {
    expect(summarize([])).toMatch(/No configuration from another coding tool/);
  });

  it("groups by kind and names the tools", async () => {
    await put(cwd, "CLAUDE.md");
    await put(cwd, ".cursorrules");
    const text = summarize(await find());
    expect(text).toMatch(/Instruction files.*2/);
    expect(text).toContain("Cursor");
  });

  // A real project had 218 remembered facts; listing them all would bury the summary.
  it("caps the file list and says how many more there are", async () => {
    for (let i = 0; i < 9; i++) {
      await put(home, join(".claude", "projects", claudeProjectSlug(cwd), "memory", `m${i}.md`), "x");
    }
    expect(summarize(await find())).toMatch(/\+5 more/);
  });
});
