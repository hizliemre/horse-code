import { describe, it, expect } from "vitest";
import { rememberFactTool } from "../../src/tools/remember.js";

const ctx = (over: Record<string, unknown> = {}) => ({ cwd: "/tmp", signal: new AbortController().signal, ...over });

describe("remember_fact tool", () => {
  it("calls ctx.remember with the fact and confirms", async () => {
    const saved: string[] = [];
    const res = await rememberFactTool.run({ fact: "tests live in /spec" }, ctx({ remember: (f: string) => saved.push(f) }));
    expect(res.isError).toBe(false);
    expect(res.content).toContain("Remembered: tests live in /spec");
    expect(saved).toEqual(["tests live in /spec"]);
  });

  it("errors when no memory sink is wired", async () => {
    const res = await rememberFactTool.run({ fact: "x" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/not available/);
  });

  it("errors on invalid or empty args", async () => {
    expect((await rememberFactTool.run({}, ctx({ remember: () => {} }))).isError).toBe(true);
    expect((await rememberFactTool.run({ fact: "   " }, ctx({ remember: () => {} }))).isError).toBe(true);
  });
});
