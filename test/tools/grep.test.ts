import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepTool } from "../../src/tools/grep.js";

let dir: string;
const ctx = () => ({ cwd: dir, signal: new AbortController().signal });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hc-grep-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("grep", () => {
  it("returns matching lines in path:line:text format", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/a.ts"), "const foo = 1;\nconst bar = 2;", "utf8");
    const res = await grepTool.run({ pattern: "foo" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.content).toContain("src/a.ts:1:const foo = 1;");
    expect(res.content).not.toContain("bar");
  });

  it("reports when there are no matches (isError:false)", async () => {
    await writeFile(join(dir, "a.txt"), "nothing", "utf8");
    const res = await grepTool.run({ pattern: "zzz" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.content).toContain("no matches");
  });

  it("returns isError on broken regex", async () => {
    const res = await grepTool.run({ pattern: "(" }, ctx());
    expect(res.isError).toBe(true);
  });

  it("does not throw on invalid args, returns isError:true", async () => {
    const res = await grepTool.run({}, ctx());
    expect(res.isError).toBe(true);
  });
});

/**
 * `flags` means REGEX flags, and a model reaching for grep reaches for grep's command line. Seen in a real
 * run: `flags: "-m 3"` — grep's max-count — handed straight to `new RegExp`, which threw "Invalid flags
 * supplied to RegExp constructor" and cost the turn.
 */
describe("grep tells regex flags from grep's command-line options", () => {
  it("refuses a CLI option instead of failing inside RegExp", async () => {
    await writeFile(join(dir, "a.ts"), "alpha\nbeta\n", "utf8");
    const r = await grepTool.run({ pattern: "alpha", flags: "-m 3" }, ctx() as never);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not a regex flag");
    expect(r.content).not.toContain("RegExp constructor"); // the model gets the distinction, not the stack
  });

  /**
   * Salvaging letters would be worse than failing: "-m 3" contains `m`, a real JS flag, so the call would
   * have silently run in multiline mode and answered a question nobody asked.
   */
  it("does not salvage a valid flag letter out of an invalid string", async () => {
    await writeFile(join(dir, "a.ts"), "alpha\n", "utf8");
    expect((await grepTool.run({ pattern: "alpha", flags: "-m 3" }, ctx() as never)).isError).toBe(true);
  });

  it("still accepts real regex flags", async () => {
    await writeFile(join(dir, "a.ts"), "ALPHA\n", "utf8");
    const r = await grepTool.run({ pattern: "alpha", flags: "i" }, ctx() as never);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("ALPHA");
  });

  it("treats an absent or empty flags value as no flags", async () => {
    await writeFile(join(dir, "a.ts"), "alpha\n", "utf8");
    for (const flags of [undefined, "", "  "]) {
      expect((await grepTool.run({ pattern: "alpha", ...(flags === undefined ? {} : { flags }) }, ctx() as never)).isError).toBeFalsy();
    }
  });
});

/**
 * The correction that arrives before the call.
 *
 * Refusing `-rn` is right, but a refusal only reaches the agent that already made the mistake — the next one
 * starts with no memory of it. Measured in one live run: two of twenty-five calls passed grep's command-line
 * options, and the parameter they were passed to had no description at all.
 */
describe("grep says what its parameters are, in the schema", () => {
  const shape = (grepTool.parameters as unknown as {
    shape: {
      pattern: { description?: string };
      flags: { description?: string };
      include: { description?: string };
    };
  }).shape;

  it("tells the caller that flags are RegExp flags, not command-line options", () => {
    const said = shape.flags.description ?? "";
    expect(said).toMatch(/RegExp flags/i);
    expect(said).toMatch(/-r|-n/);        // names the exact mistake that was measured
    expect(said).toMatch(/include/);      // …and points at the parameter that does what -rn --include did
  });

  it("offers include, which is the thing the command line was being used to ask for", () => {
    expect(shape.include.description ?? "").toMatch(/\*\.cs|glob/i);
  });

  it("says the pattern is a regular expression, which is the other half of the same confusion", () => {
    expect(shape.pattern.description ?? "").toMatch(/regular expression/i);
  });

  it("still refuses the options it now warns about", async () => {
    for (const flags of ["-n", "-rn", "-m 3"]) {
      const r = await grepTool.run({ pattern: "alpha", flags }, ctx() as never);
      expect(r.isError, flags).toBe(true);
    }
  });
});

/**
 * WHICH files, not just which pattern.
 *
 * Measured live: five of twenty-eight grep calls in one run passed grep's command line, the last of them
 * `flags: "-rn --include=*.cs"`. The model was not confused about regex flags — it wanted to search only the
 * C# files and the tool had no parameter for it. See the run body in src/tools/grep.ts.
 */
describe("grep include", () => {
  beforeEach(async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/Thing.cs"), "class Thing { void SetValues() {} }", "utf8");
    await writeFile(join(dir, "src/thing.ts"), "export function SetValues() {}", "utf8");
    await writeFile(join(dir, "notes.md"), "SetValues is described here", "utf8");
  });

  it("searches only the files the glob names", async () => {
    const r = await grepTool.run({ pattern: "SetValues", include: "**/*.cs" }, ctx() as never);
    expect(r.isError).toBe(false);
    expect(r.content).toContain("Thing.cs");
    expect(r.content).not.toContain("thing.ts");
    expect(r.content).not.toContain("notes.md");
  });

  it("takes a bare extension glob, which is what a caller reaches for first", async () => {
    const r = await grepTool.run({ pattern: "SetValues", include: "*.md" }, ctx() as never);
    expect(r.content).toContain("notes.md");
    expect(r.content).not.toContain("Thing.cs");
  });

  it("searches everything when it is omitted — the old behaviour is the default", async () => {
    const r = await grepTool.run({ pattern: "SetValues" }, ctx() as never);
    for (const f of ["Thing.cs", "thing.ts", "notes.md"]) expect(r.content).toContain(f);
  });

  it("takes a single exact path, which is the other thing the command line was being used for", async () => {
    // Measured live: `flags: "-n src/features/Products/CompareAndSaveProducts.cs"` — a file path in the field
    // for regex letters. The model wanted ONE file, and a bare path is a glob that matches only itself.
    const r = await grepTool.run(
      { pattern: "SetValues", include: "src/Thing.cs" }, ctx() as never);
    expect(r.content).toContain("Thing.cs");
    expect(r.content).not.toContain("thing.ts");
  });

  it("says 'no matches' rather than failing when the glob excludes everything", async () => {
    const r = await grepTool.run({ pattern: "SetValues", include: "**/*.py" }, ctx() as never);
    expect(r.isError).toBe(false);
    expect(r.content).toBe("no matches");
  });

  it("keeps include in the call's identity, so two different filters are two different calls", async () => {
    const { subjectOfArgs } = await import("../../src/agent/elide.js");
    const cs = subjectOfArgs({ pattern: "SetValues", include: "*.cs" });
    const ts = subjectOfArgs({ pattern: "SetValues", include: "*.ts" });
    expect(cs).not.toBe(ts);      // …or Recall would answer the second from the first
    expect(cs).toContain("include=*.cs");
  });
});
