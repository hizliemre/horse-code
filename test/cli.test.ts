import { describe, it, expect } from "vitest";
import { parseArgs, renderResult, shouldUseTui } from "../src/cli.js";

const DELIVERY = { branch: "hc/job/base", worktree: "/tmp/wt" };

describe("parseArgs", () => {
  it("prompt + flags", () => {
    expect(parseArgs(["Add X", "--branch", "dev", "--rounds", "2"])).toEqual({ prompt: "Add X", fromBranch: "dev", rounds: 2 });
  });
  it("multi-word prompt joins; short flags", () => {
    expect(parseArgs(["hello", "world", "-b", "main", "-j", "name"])).toEqual({ prompt: "hello world", fromBranch: "main", jobName: "name" });
  });
  it("parseArgs --revision-rounds", () => {
    expect(parseArgs(["X", "--revision-rounds", "2"])).toEqual({ prompt: "X", revisionRounds: 2 });
  });
});

describe("renderResult", () => {
  it("chat → response", () => {
    expect(renderResult({ kind: "chat", response: "answer" })).toBe("answer");
  });
  it("rejected → contains the stage", () => {
    expect(renderResult({ kind: "rejected", stage: "spec" })).toContain("spec");
  });
  it("done → report + PR url", () => {
    const out = renderResult({
      kind: "done", report: "report",
      wave: { status: "completed", session: {} as never, pr: { url: "http://pr" }, waves: [], delivery: DELIVERY },
      session: {} as never,
    });
    expect(out).toContain("report");
    expect(out).toContain("http://pr");
  });
  it("renderResult done: writes the revision status", () => {
    const out = renderResult({
      kind: "done", report: "report",
      wave: { status: "completed", session: {} as never, pr: { url: "http://pr" }, waves: [], delivery: DELIVERY },
      revision: { status: "approved", rounds: 0 },
      session: {} as never,
    });
    expect(out).toContain("revision");
  });
});

describe("cli TUI branching", () => {
  it("parseArgs reads the --no-tui flag", () => {
    expect(parseArgs(["--no-tui", "do", "something"]).noTui).toBe(true);
    expect(parseArgs(["do", "something"]).noTui).toBeUndefined();
  });

  it("shouldUseTui: stdin+stdout TTY and no --no-tui → true", () => {
    expect(shouldUseTui(true, true, false)).toBe(true);
  });

  it("shouldUseTui: stdout not TTY → false (pipe/CI)", () => {
    expect(shouldUseTui(true, false, false)).toBe(false);
  });

  it("shouldUseTui: stdin not TTY → false (echo x | hcode; prevents an Ink raw-mode crash)", () => {
    expect(shouldUseTui(false, true, false)).toBe(false);
  });

  it("shouldUseTui: --no-tui → false (even if both are TTY)", () => {
    expect(shouldUseTui(true, true, true)).toBe(false);
  });
});
