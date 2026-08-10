import { describe, it, expect } from "vitest";
import { inUserLanguage, isEnglish } from "../../src/engine/user-language.js";
import type { ReviewDeps } from "../../src/engine/review.js";
import type { RoleConfig } from "../../src/config/config.js";
import type { ChatEvent } from "../../src/core/types.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { MockProvider } from "../../src/providers/mock.js";
import { reviewBodies } from "../support/review-bodies.js";
import { fakeSpecKit } from "../support/fake-speckit.js";

function submit(text: string): ChatEvent[] {
  return [
    { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: JSON.stringify({ text }) } },
    { type: "done", finishReason: "tool_calls" },
  ];
}

function deps(provider: MockProvider): ReviewDeps {
  const roles: Record<string, RoleConfig> = { refiner: { models: ["m"], systemPrompt: "P-refiner" } };
  return {
    provider,
    roleRegistry: new RoleRegistry(roles, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: new AbortController().signal,
    specKit: fakeSpecKit,
    ...reviewBodies(),
  };
}

describe("isEnglish", () => {
  it("treats an absent or English language as 'leave it alone'", () => {
    expect(isEnglish(undefined)).toBe(true);
    expect(isEnglish("")).toBe(true);
    expect(isEnglish("  ")).toBe(true);
    expect(isEnglish("English")).toBe(true);
    expect(isEnglish("english")).toBe(true);
    expect(isEnglish("Turkish")).toBe(false);
  });
});

describe("inUserLanguage", () => {
  it("costs nothing when there is nothing to translate", async () => {
    const p = new MockProvider([]);
    expect(await inUserLanguage(deps(p), "Which branch?", "English")).toBe("Which branch?");
    expect(p.requests.length).toBe(0); // the common case must not pay for a model call
  });

  it("returns the translation, and tells the model which language to use", async () => {
    const p = new MockProvider([submit("Bu projenin ana dalı hangisi?")]);
    const said = await inUserLanguage(deps(p), "Which branch is this project's main one?", "Turkish");
    expect(said).toBe("Bu projenin ana dalı hangisi?");
    const sent = p.requests[0]!.messages.map((m) => String(m.content)).join("\n");
    expect(sent).toContain("Language: Turkish");
    expect(sent).toContain("Which branch is this project's main one?");
  });

  it("falls back to the original text when the model fails — a question in English still asks", async () => {
    const p = new MockProvider([[{ type: "done", finishReason: "stop" }]]); // no submit → structured call throws
    expect(await inUserLanguage(deps(p), "Which branch?", "Turkish")).toBe("Which branch?");
  });

  it("an empty translation is not an answer — the original is asked instead", async () => {
    const p = new MockProvider([submit("   ")]);
    expect(await inUserLanguage(deps(p), "Which branch?", "Turkish")).toBe("Which branch?");
  });
});
