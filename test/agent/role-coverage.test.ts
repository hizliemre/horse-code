import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";

/**
 * Every agent says who it is, including the ones that bring their own prompt.
 *
 * The name was put on `resolve()` alone, on the assumption that every caller spreads a resolved role. Seven
 * callers do not — they take the model chain from `fallbackOpts` and supply their own system prompt, which
 * is the whole point of that method. Measured on the first run after the change: 19 tool calls, exactly one
 * of them attributed, and the eighteen that mattered (the tester's reads, greps and shell) anonymous.
 *
 * So the name belongs to the chain, and a caller that destructures the chain has to carry it.
 */
describe("the role name reaches every agent", () => {
  const registry = (): RoleRegistry => new RoleRegistry(
    { tester: { models: ["m"], systemPrompt: "P" } }, {}, new SkillRegistry());

  it("comes with the model chain, not only with the prompt", () => {
    expect(registry().fallbackOpts("tester").role).toBe("tester");
  });

  it("is still on a fully resolved role", () => {
    expect(registry().resolve("tester").role).toBe("tester");
  });

  it("is carried by every caller that destructures the chain", () => {
    const files = execFileSync("git", ["ls-files", "src"], { encoding: "utf8" })
      .split("\n").filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
    const missing: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      text.split("\n").forEach((line, i) => {
        if (!line.includes("fallbackOpts(")) return;
        if (!line.includes("const {")) return;   // a type reference, not a destructure
        // The chain is being unpacked by name — the role must be among the names taken.
        if (!/\brole\s*:/.test(line)) missing.push(`${file}:${i + 1} ${line.trim()}`);
      });
    }
    expect(missing, `these unpack the model chain without taking the role with it:\n${missing.join("\n")}`)
      .toEqual([]);
  });
});
