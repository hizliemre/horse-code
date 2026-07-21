import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { shellTool } from "../../src/tools/shell.js";

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
