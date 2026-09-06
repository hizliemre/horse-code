import { spawn } from "node:child_process";

/**
 * Running the commands an acceptance criterion names, so the gate settles them instead of an agent's patience.
 *
 * The pipeline deliberately puts build, lint and format checks into acceptance criteria — `tasksMessage` says
 * so, because giving each command a card of its own costs a full implement-and-review round for a command.
 * The gate then could not settle them: its prompt says "verify by LOOKING", and no amount of looking tells
 * you whether `dotnet build` succeeds.
 *
 * What the agent did instead is on the board, verbatim: "Executed `dotnet build parrot.slnx`. The build did
 * not exit or produce a success result after repeated 30-second polls (more than 210 seconds total), so a
 * successful build was not observably verified." It gave up at 210 seconds — well inside its own budget —
 * and the card came back. Measured over one board: 112 acceptance criteria, 29 of them command-shaped, and
 * those 29 produced 37 of the 39 acceptance failures. The 83 criteria that can be checked by reading
 * produced two.
 *
 * So the harness runs them, once, with a real timeout, and hands the exit code to the gate as evidence —
 * exactly as it already does for the project's test suite.
 */

/**
 * The first word a criterion's command may have.
 *
 * The criterion text is written by a MODEL, so this is the boundary between "check the build" and "run
 * whatever this sentence says". Everything here is a build, test or format tool; nothing here reads or
 * writes outside the project, and nothing is a shell.
 */
export const RUNNABLE_COMMANDS: readonly string[] = [
  "dotnet", "npm", "npx", "pnpm", "yarn", "nx", "prettier", "eslint", "tsc", "cargo", "go", "make", "mvn", "gradle",
];

/** Shell syntax in a backticked span means it was never a single command, and we do not run a shell. */
const SHELL_SYNTAX = /[;&|><$(){}\n]|`/;

export interface CommandRun {
  argv: string[];
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

/** How long one criterion command may run. A real build is minutes; the point is that it FINISHES. */
export const CRITERION_TIMEOUT_MS = 10 * 60 * 1000;
/** Enough of the tail to show why a command failed, without carrying a build log into a prompt. */
const MAX_OUTPUT = 2_000;

/**
 * The commands a criterion names, as argv arrays.
 *
 * Backticks are the signal: every command criterion on the board writes its command in them — "`dotnet
 * build` başarıyla tamamlanır", "Prettier, ilgili Nx lint komutları ve `nx build beempa` başarıyla
 * tamamlanır". Prose outside them is a description, not an instruction.
 */
export function commandsIn(criterion: string): string[][] {
  const out: string[][] = [];
  for (const m of criterion.matchAll(/`([^`\n]+)`/g)) {
    const span = m[1].trim();
    if (!span || SHELL_SYNTAX.test(span)) continue;
    const argv = span.split(/\s+/);
    // A path is not a command: "`SupplierChannelLifecycle.cs`, …" names a file to read, not a thing to run.
    if (!RUNNABLE_COMMANDS.includes(argv[0])) continue;
    out.push(argv);
  }
  return out;
}

/** Runs one command to completion, or kills it. Never throws: a command that cannot start is a failed one. */
export async function runCommand(cwd: string, argv: string[], timeoutMs = CRITERION_TIMEOUT_MS): Promise<CommandRun> {
  const [bin, ...args] = argv;
  return new Promise<CommandRun>((resolve) => {
    let child;
    try {
      // No shell, and stdin closed: a command that stops to ask something would wait for a human who is not
      // there — the same reason the test runner closes it.
      child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
    } catch (e) {
      resolve({ argv, passed: false, exitCode: null, timedOut: false, output: e instanceof Error ? e.message : String(e) });
      return;
    }
    let out = "";
    const take = (d: Buffer): void => {
      out += d.toString();
      if (out.length > MAX_OUTPUT * 4) out = out.slice(-MAX_OUTPUT * 2);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ argv, passed: false, exitCode: null, timedOut: false, output: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ argv, passed: !timedOut && code === 0, exitCode: code, timedOut, output: out.slice(-MAX_OUTPUT) });
    });
  });
}

/**
 * Every distinct command the criteria name, run once each.
 *
 * Once each, not once per criterion: two criteria asking for `nx build beempa` are one build, and building
 * twice to answer the same question is the cost this exists to remove.
 */
export async function runCriterionCommands(
  cwd: string, criteria: readonly string[], timeoutMs = CRITERION_TIMEOUT_MS,
): Promise<CommandRun[]> {
  const seen = new Set<string>();
  const argvs: string[][] = [];
  for (const c of criteria) {
    for (const argv of commandsIn(c)) {
      const key = argv.join(" ");
      if (seen.has(key)) continue;
      seen.add(key);
      argvs.push(argv);
    }
  }
  const runs: CommandRun[] = [];
  // Serial: these are builds. Running four at once on one worktree is how a build server falls over.
  for (const argv of argvs) runs.push(await runCommand(cwd, argv, timeoutMs));
  return runs;
}

/** What the gate is told about them — the exit code, and the tail when it failed. */
export function describeCommandRuns(runs: readonly CommandRun[]): string {
  if (!runs.length) return "";
  const lines = runs.map((r) => {
    const cmd = `\`${r.argv.join(" ")}\``;
    if (r.timedOut) return `- ${cmd} — TIMED OUT after ${Math.round(CRITERION_TIMEOUT_MS / 60000)} minutes.`;
    if (r.passed) return `- ${cmd} — SUCCEEDED (exit 0).`;
    return `- ${cmd} — FAILED (exit ${r.exitCode ?? "none"}):\n\`\`\`\n${r.output.slice(-800)}\n\`\`\``;
  });
  return (
    "The harness has already RUN the commands these criteria name, to completion, and this is what happened. "
    + "Use this as the evidence for any criterion about one of them — do not run it again, and do not report a "
    + "criterion unmet because you could not wait for it:\n"
    + lines.join("\n")
  );
}
