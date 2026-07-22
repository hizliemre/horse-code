import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fuzzyScore, atToken, rankFiles, listProjectFiles } from "../../src/tui/file-search.js";

describe("fuzzyScore", () => {
  it("returns -1 when not all query chars appear in order", () => {
    expect(fuzzyScore("xyz", "src/app.ts")).toBe(-1);
    expect(fuzzyScore("pta", "src/app.ts")).toBe(-1); // wrong order
  });

  it("scores a subsequence match, 0 for an empty query", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("app", "src/app.ts")).toBeGreaterThan(0);
  });

  it("ranks a contiguous / word-boundary match above a scattered one", () => {
    // scattered target: a/p/p separated by non-boundary chars → low score
    expect(fuzzyScore("app", "src/app.ts")).toBeGreaterThan(fuzzyScore("app", "xaxpxxpxx.ts"));
  });
});

describe("atToken", () => {
  it("finds the @query token at the cursor", () => {
    expect(atToken("see @src/ap", 11)).toEqual({ start: 4, query: "src/ap" });
    expect(atToken("@app", 4)).toEqual({ start: 0, query: "app" });
  });

  it("returns null when there is no @, when @ is mid-word, or the query has whitespace", () => {
    expect(atToken("no token here", 5)).toBeNull();
    expect(atToken("email@host", 10)).toBeNull(); // @ not preceded by whitespace/start
    expect(atToken("@foo bar", 8)).toBeNull(); // cursor past a space → token ended
  });
});

describe("rankFiles", () => {
  it("returns the best matches first, capped by limit", () => {
    const files = ["src/app.ts", "src/tui/app.tsx", "README.md", "src/apple.ts"];
    const out = rankFiles(files, "app", 2);
    expect(out).toHaveLength(2);
    expect(out).toContain("src/app.ts");
    expect(out).not.toContain("README.md"); // no subsequence match
  });

  it("empty query returns files (shortest path first)", () => {
    const out = rankFiles(["aaaa/bbbb.ts", "a.ts"], "", 8);
    expect(out[0]).toBe("a.ts");
  });
});

describe("listProjectFiles", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-fs-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("lists relative paths and skips node_modules/.git", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "node_modules", "x"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "x");
    await writeFile(join(dir, "README.md"), "x");
    await writeFile(join(dir, "node_modules", "x", "index.js"), "x");
    const files = await listProjectFiles(dir);
    expect(files.sort()).toEqual(["README.md", join("src", "a.ts")].sort());
  });
});
