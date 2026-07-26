import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectTestCommand, runProjectTests, describeTestRun, MAX_TEST_OUTPUT,
} from "../../src/engine/test-runner.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-tests-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const write = async (f: string, body: string): Promise<void> => {
  await mkdir(join(dir, f, ".."), { recursive: true });
  await writeFile(join(dir, f), body, "utf8");
};
const pkg = (scripts: Record<string, string>): Promise<void> =>
  write("package.json", JSON.stringify({ scripts }));

describe("detectTestCommand", () => {
  it("uses the package script", async () => {
    await pkg({ test: "vitest run" });
    expect((await detectTestCommand(dir))?.argv).toEqual(["npm", "test"]);
  });

  // `npm test` in a pnpm project can resolve a different dependency tree than the one the project uses.
  it.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
  ])("lets %s choose the runner", async (lock, runner) => {
    await pkg({ test: "vitest run" });
    await write(lock, "");
    expect((await detectTestCommand(dir))?.argv[0]).toBe(runner);
  });

  /** `ng test` defaults to a watching, browser-opening run — which never returns in a gate. */
  it("forces a headless single run for Angular", async () => {
    await pkg({ test: "ng test" });
    const got = (await detectTestCommand(dir))!;
    expect(got.argv).toContain("--watch=false");
    expect(got.argv).toContain("--browsers=ChromeHeadless");
  });

  it("leaves an already-configured ng test alone", async () => {
    await pkg({ test: "ng test --watch=false" });
    expect((await detectTestCommand(dir))?.argv).toEqual(["npm", "test"]);
  });

  // npm writes this when there are no tests; treating it as a suite would fail every scaffolded project.
  it("ignores npm's placeholder", async () => {
    await pkg({ test: 'echo "Error: no test specified" && exit 1' });
    expect(await detectTestCommand(dir)).toBeUndefined();
  });

  it.each([
    ["pytest.ini", "python3"],
    ["go.mod", "go"],
    ["Cargo.toml", "cargo"],
    ["Gemfile", "bundle"],
  ])("recognises %s", async (file, bin) => {
    await write(file, "");
    expect((await detectTestCommand(dir))?.argv[0]).toBe(bin);
  });

  /** Inventing a command would run something arbitrary in the user's worktree. */
  it("yields nothing for a project it does not recognise", async () => {
    await write("main.c", "int main(){}");
    expect(await detectTestCommand(dir)).toBeUndefined();
  });

  it("survives an unreadable manifest", async () => {
    await write("package.json", "{ not json");
    expect(await detectTestCommand(dir)).toBeUndefined();
  });

  it("says why it chose the command, so the choice is checkable", async () => {
    await pkg({ test: "vitest run" });
    expect((await detectTestCommand(dir))?.why).toContain("vitest run");
  });
});

describe("runProjectTests", () => {
  it("reports a passing suite", async () => {
    await pkg({ test: 'node -e "process.exit(0)"' });
    const r = await runProjectTests(dir);
    expect(r).toMatchObject({ skipped: false, passed: true, timedOut: false });
  });

  it("reports a failing suite with its output", async () => {
    await pkg({ test: 'node -e "console.log(\'BOOM\'); process.exit(1)"' });
    const r = await runProjectTests(dir);
    expect(r.passed).toBe(false);
    expect(r.output).toContain("BOOM");
  });

  it("captures stderr as well as stdout", async () => {
    await pkg({ test: 'node -e "console.error(\'ON-STDERR\'); process.exit(1)"' });
    expect((await runProjectTests(dir)).output).toContain("ON-STDERR");
  });

  // A project that does not test has not broken anything by not testing.
  it("skips a project with no suite, and calls it passed", async () => {
    expect(await runProjectTests(dir)).toMatchObject({ skipped: true, passed: true });
  });

  /** The project may simply not have its dependencies installed; that is not a red suite. */
  it("skips rather than fails when the runner is missing", async () => {
    const r = await runProjectTests(dir, { argv: ["definitely-not-a-real-binary-xyz"], why: "test" });
    expect(r.skipped).toBe(true);
    expect(r.output).toMatch(/could not run the suite/);
  });

  /**
   * Sized to exceed the in-flight trim threshold (4x the cap) and nothing more. An earlier version printed
   * 200,000 lines, which passed alone and timed out under the parallel load of the full suite — a slow test
   * that fails only when run with everything else is worse than no test.
   */
  it("keeps only the tail of a chatty suite", async () => {
    const lines = Math.ceil((MAX_TEST_OUTPUT * 5) / 10); // ~10 chars per line
    await pkg({ test: `node -e "for(let i=0;i<${lines};i++)console.log('noise'+i); process.exit(1)"` });
    const r = await runProjectTests(dir);
    expect(r.output.length).toBeLessThanOrEqual(MAX_TEST_OUTPUT + 200);
    // The tail is what matters: failures are printed last.
    expect(r.output).toContain(`noise${lines - 1}`);
  }, 30_000);

  it("closes stdin so a suite that asks a question cannot hang", async () => {
    await pkg({ test: `node -e "const c=require('fs').readFileSync(0,'utf8'); process.exit(c?1:0)"` });
    expect((await runProjectTests(dir)).passed).toBe(true);
  });
});

describe("describeTestRun", () => {
  /** An agent told "the suite failed" without the output cannot tell a related failure from an unrelated one. */
  it("hands a failure to the agent as evidence, with the output", () => {
    const text = describeTestRun({ skipped: false, passed: false, command: "npm test", output: "3 failing", timedOut: false });
    expect(text).toMatch(/FAILED/);
    expect(text).toContain("3 failing");
    expect(text).toMatch(/evidence, not opinion/);
  });

  it("tells the agent to say so explicitly if the failures are unrelated", () => {
    const text = describeTestRun({ skipped: false, passed: false, output: "", timedOut: false });
    expect(text).toMatch(/say so explicitly in the evidence rather than ignoring them/);
  });

  it("treats a timeout as a failure", () => {
    const text = describeTestRun({ skipped: false, passed: false, output: "", timedOut: true });
    expect(text).toMatch(/Treat this as a FAILURE/);
  });

  it("tells the agent to fall back to reading when there is no suite", () => {
    expect(describeTestRun({ skipped: true, passed: true, output: "", timedOut: false }))
      .toMatch(/no test suite. Judge the criteria by reading/);
  });

  it("says when the suite existed but could not be run", () => {
    expect(describeTestRun({ skipped: true, passed: true, output: "command not found", timedOut: false }))
      .toMatch(/could not be run \(command not found\)/);
  });

  it("is brief when the suite passed", () => {
    expect(describeTestRun({ skipped: false, passed: true, command: "npm test", output: "", timedOut: false }))
      .toMatch(/passed/);
  });
});
