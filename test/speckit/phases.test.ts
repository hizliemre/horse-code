import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSpecify, runConstitution } from "../../src/speckit/phases.js";
import { scaffoldFeature, constitutionPath } from "../../src/speckit/layout.js";
import { MockProvider } from "../../src/providers/mock.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { ChatEvent } from "../../src/core/types.js";
import type { SpecKitTemplates } from "../../src/speckit/templates.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";

const fakeTemplates: SpecKitTemplates = {
  version: "test",
  template: (n) => `TEMPLATE:${n}`,
  command: (n) => `COMMAND:${n}`,
};
function deps(p: MockProvider): TaskCycleDeps {
  const roles = { analyst: { models: ["m"], systemPrompt: "a" }, planner: { models: ["m"], systemPrompt: "p" }, "project-manager": { models: ["m"], systemPrompt: "t" } };
  return {
    provider: p,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: new AbortController().signal,
  };
}
const writeTurn = (path: string, content: string): ChatEvent[] => [
  { type: "tool-call", toolCall: { id: "w", name: "write_file", arguments: JSON.stringify({ path, content }) } },
  { type: "done", finishReason: "tool_calls" },
];

let wd: string;
beforeEach(async () => { wd = await mkdtemp(join(tmpdir(), "hc-ph-")); });
afterEach(async () => { await rm(wd, { recursive: true, force: true }); });

describe("spec-kit phases", () => {
  it("runSpecify writes spec.md via the role using the spec-kit command + template", async () => {
    const paths = scaffoldFeature(wd, "001-x");
    const p = new MockProvider([writeTurn(paths.spec, "# Spec\nok"), [{ type: "done", finishReason: "stop" }]]);
    await runSpecify({ deps: deps(p), templates: fakeTemplates, workdir: wd, askUser: async () => "" }, paths, "Build X");
    expect(await readFile(paths.spec, "utf8")).toContain("# Spec");
    // the spec-kit command + template were handed to the model
    const sys = p.requests[0].messages.find((m) => m.role === "system")?.content ?? "";
    const usr = JSON.stringify(p.requests[0].messages);
    expect(sys).toContain("COMMAND:specify");
    expect(usr).toContain("TEMPLATE:spec");
  });

  it("runConstitution writes the constitution file", async () => {
    scaffoldFeature(wd, "001-x");
    const cp = constitutionPath(wd);
    const p = new MockProvider([writeTurn(cp, "# Constitution"), [{ type: "done", finishReason: "stop" }]]);
    await runConstitution({ deps: deps(p), templates: fakeTemplates, workdir: wd, askUser: async () => "answer" });
    expect(existsSync(cp)).toBe(true);
  });
});
