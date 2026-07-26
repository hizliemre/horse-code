import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { clampOutput } from "../tools/shell.js";

/**
 * Running the project's own tests as part of the completion gate.
 *
 * Every reviewing agent in this pipeline reads: the code lenses, the council, the judge and the acceptance
 * gate all have read/grep/glob and nothing else. So the whole quality apparatus answers "does this diff look
 * right?" and none of it can answer "does it work?" — which is the question that matters when changing code
 * that already exists, because the failure mode there is breaking something the diff does not mention.
 *
 * The suite answers exactly that, and it is the one check that cannot be talked into agreeing.
 */

export interface TestCommand {
  /** Argv, not a shell string: nothing here is interpolated into a shell. */
  argv: string[];
  /** What made us choose it, reported so the decision is checkable. */
  why: string;
}

export interface TestRun {
  /** No test setup found — not a failure, and never treated as one. */
  skipped: boolean;
  passed: boolean;
  command?: string;
  why?: string;
  /** Tail of the output, budgeted. What a reviewer needs is the failures, which come last. */
  output: string;
  timedOut: boolean;
}

/** Tests can be slow; a suite that hangs must not hang the wave. */
export const TEST_TIMEOUT_MS = 600_000;
/** Only the tail is kept: a passing suite's chatter is noise, and failures are printed last. */
export const MAX_TEST_OUTPUT = 12_000;

/** npm writes this when there are no tests. Treating it as a suite would fail every scaffolded project. */
const PLACEHOLDER = /no test specified/i;

/**
 * Works out how to run this project's tests.
 *
 * Deliberately conservative: an unrecognised project yields nothing and the gate skips, because inventing a
 * command would run something arbitrary in the user's worktree. Detection reads manifests, never guesses
 * from directory names.
 */
export async function detectTestCommand(cwd: string): Promise<TestCommand | undefined> {
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      const script = pkg.scripts?.test;
      if (script && !PLACEHOLDER.test(script)) {
        // The lockfile decides the runner: `npm test` in a pnpm project can resolve a different tree.
        const runner = existsSync(join(cwd, "pnpm-lock.yaml")) ? "pnpm"
          : existsSync(join(cwd, "yarn.lock")) ? "yarn"
          : existsSync(join(cwd, "bun.lockb")) ? "bun"
          : "npm";
        // Angular/karma and similar default to a watching, browser-opening run; CI mode is what a gate needs.
        const ci = /\bng test\b/.test(script) && !/--watch|--no-watch/.test(script)
          ? ["--", "--watch=false", "--browsers=ChromeHeadless"]
          : [];
        return { argv: [runner, "test", ...ci], why: `package.json scripts.test: ${script}` };
      }
    } catch { /* unreadable manifest → fall through to the other ecosystems */ }
  }
  if (existsSync(join(cwd, "pytest.ini")) || existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "tox.ini"))) {
    return { argv: ["python3", "-m", "pytest", "-q"], why: "a pytest configuration is present" };
  }
  if (existsSync(join(cwd, "go.mod"))) return { argv: ["go", "test", "./..."], why: "go.mod is present" };
  if (existsSync(join(cwd, "Cargo.toml"))) return { argv: ["cargo", "test"], why: "Cargo.toml is present" };
  if (existsSync(join(cwd, "Gemfile"))) return { argv: ["bundle", "exec", "rspec"], why: "a Gemfile is present" };
  return undefined;
}

/**
 * Runs the suite and reports what happened.
 *
 * A missing test setup is SKIPPED, never failed: a project that does not test has not broken anything by not
 * testing, and failing it would make the gate unusable everywhere it is not already green.
 */
export async function runProjectTests(cwd: string, cmd?: TestCommand): Promise<TestRun> {
  const command = cmd ?? await detectTestCommand(cwd);
  if (!command) return { skipped: true, passed: true, output: "", timedOut: false };

  const [bin, ...args] = command.argv;
  return new Promise<TestRun>((resolve) => {
    // stdin is closed: a suite that stops to ask something would otherwise wait for a human who is not there.
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
    let out = "";
    const take = (d: Buffer): void => {
      out += d.toString();
      // Keep only the tail while running, so a suite that prints megabytes cannot exhaust memory.
      if (out.length > MAX_TEST_OUTPUT * 4) out = out.slice(-MAX_TEST_OUTPUT * 2);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, TEST_TIMEOUT_MS);
    const done = (code: number, extra = ""): void => {
      clearTimeout(timer);
      resolve({
        skipped: false,
        passed: code === 0 && !timedOut,
        command: command.argv.join(" "),
        why: command.why,
        output: clampOutput(`${extra}${out}`.trimEnd(), MAX_TEST_OUTPUT),
        timedOut,
      });
    };
    // A missing runner is not a failing suite — the project may simply not have its dependencies installed.
    child.on("error", (e) => { clearTimeout(timer); resolve({
      skipped: true, passed: true, command: command.argv.join(" "), why: command.why,
      output: `could not run the suite: ${e.message}`, timedOut: false,
    }); });
    child.on("close", (code) => done(code ?? 1));
  });
}

/** How the run is described to a reviewing agent — the output matters, so it is not summarised away. */
export function describeTestRun(run: TestRun): string {
  if (run.skipped) {
    return run.output
      ? `The project's test suite could not be run (${run.output}). Judge the criteria by reading the code.`
      : "This project has no test suite. Judge the criteria by reading the code.";
  }
  if (run.timedOut) {
    return `The test suite (\`${run.command}\`) was killed after ${TEST_TIMEOUT_MS / 60_000} minutes without ` +
      `finishing. Treat this as a FAILURE unless the criteria are unrelated to it.\n\n${run.output}`;
  }
  if (run.passed) return `The project's test suite passed (\`${run.command}\`).`;
  return `The project's test suite FAILED (\`${run.command}\`). This is evidence, not opinion — a criterion ` +
    `about behaviour cannot be met while the suite is red. If the failures are clearly unrelated to this ` +
    `task's criteria, say so explicitly in the evidence rather than ignoring them.\n\n${run.output}`;
}
