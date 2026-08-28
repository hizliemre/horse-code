import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseArgs } from "../src/cli.js";
import { hcodeVersion, usage, nearestFlag, FLAGS } from "../src/cli-info.js";

/**
 * The three things typed first after `npm install -g`.
 *
 * `hcode --version` used to open a worktree and ask a model to implement the string "--version", then print
 * "error: fetch failed" — a true statement about a question nobody asked. Unknown arguments fell through to
 * the prompt, so every flag typo had the same shape and the same cost.
 */
describe("what an installed binary is asked first", () => {
  it("reports the version from the manifest that shipped it, not a hand-maintained constant", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(hcodeVersion()).toBe(pkg.version);
  });

  it("takes --version and -v as questions, not as the request", () => {
    expect(parseArgs(["--version"])).toMatchObject({ version: true, prompt: "" });
    expect(parseArgs(["-v"])).toMatchObject({ version: true });
  });

  it("takes --help and -h the same way", () => {
    expect(parseArgs(["--help"])).toMatchObject({ help: true, prompt: "" });
    expect(parseArgs(["-h"])).toMatchObject({ help: true });
  });

  it("names an unrecognised flag instead of running it", () => {
    expect(parseArgs(["--brnach", "x"]).unknown).toBe("--brnach");
    // …and the flag never reaches the prompt, which is the whole failure.
    expect(parseArgs(["--brnach", "x"]).prompt).not.toContain("--brnach");
  });

  /**
   * A request is one quoted argument. Refusing anything that merely CONTAINS a dash would refuse the
   * requests people actually write — this is why the check is on a token that stands alone.
   */
  it("leaves a quoted request alone even when it talks about flags", () => {
    const a = parseArgs(["make --no-cache the default"]);
    expect(a.unknown).toBeUndefined();
    expect(a.prompt).toBe("make --no-cache the default");
  });

  it("still parses the real flags", () => {
    expect(parseArgs(["-b", "dev", "-j", "thing", "--rounds", "2", "--no-tui", "do it"]))
      .toMatchObject({ fromBranch: "dev", jobName: "thing", rounds: 2, noTui: true, prompt: "do it" });
  });

  it("suggests the near miss, and stays quiet when there is none", () => {
    expect(nearestFlag("--brnach")).toBe("--branch");
    expect(nearestFlag("--verison")).toBe("--version");
    expect(nearestFlag("--zzz")).toBeUndefined();
  });

  /** A help text that omits a flag is worse than none: it is evidence the flag does not exist. */
  it("documents every flag it accepts", () => {
    const text = usage();
    for (const f of FLAGS) expect(text, `${f} is missing from --help`).toContain(f);
  });

  it("tells someone with no config what to run", () => {
    expect(usage()).toContain("hcode init");
  });
});
