import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { shellTool, clampOutput, MAX_SHELL_CHARS } from "../../src/tools/shell.js";

const ctx = (signal?: AbortSignal) => ({
  cwd: tmpdir(),
  signal: signal ?? new AbortController().signal,
});

describe("shell", () => {
  it("returns the output of a successful command (exit 0)", async () => {
    const res = await shellTool.run({ command: "echo hello" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.content).toContain("hello");
  });

  it("returns isError:true for a failing command", async () => {
    const res = await shellTool.run({ command: "exit 3" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("3");
  });

  it("describe produces allowKey + preview", () => {
    const d = shellTool.describe!({ command: "npm test" });
    expect(d.allowKey).toBe("npm test");
    expect(d.preview).toBe("npm test");
  });

  it("returns isError for an already-aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await shellTool.run({ command: "echo x" }, ctx(ac.signal));
    expect(res.isError).toBe(true);
  });

  it("returns isError:true without throwing for invalid args (missing command)", async () => {
    const res = await shellTool.run({}, ctx());
    expect(res.isError).toBe(true);
  });
});

// An `ng build` / `npm install` log entered the conversation whole and was then re-sent on every later turn —
// the one large input channel with no bound at all.
describe("clampOutput", () => {
  it("leaves ordinary output untouched", () => {
    expect(clampOutput("small output")).toBe("small output");
  });

  it("keeps the head AND the tail — the failure and the exit summary live at the end", () => {
    const body = `START${"x".repeat(MAX_SHELL_CHARS * 2)}THE-ACTUAL-ERROR`;
    const out = clampOutput(body);
    expect(out.startsWith("START")).toBe(true);
    expect(out.endsWith("THE-ACTUAL-ERROR")).toBe(true);
  });

  it("stays within the budget and says what it dropped", () => {
    const out = clampOutput("y".repeat(MAX_SHELL_CHARS * 3));
    expect(out.length).toBeLessThan(MAX_SHELL_CHARS + 200);
    expect(out).toMatch(/trimmed from the middle/);
  });
});
