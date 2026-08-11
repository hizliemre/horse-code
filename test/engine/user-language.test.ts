import { describe, it, expect } from "vitest";
import { inUserLanguage, isEnglish, askInUserLanguage } from "../../src/engine/user-language.js";
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

/**
 * The engine's own questions, in the user's language — with the code's answer left intact.
 *
 * Measured: a session running entirely in Turkish was asked, by the engine, "I cannot tell how big this is
 * from the code … Which is it? (*) Small — just do it / ( ) Full piece of work" — in English, after the user
 * had said more than once which language they work in.
 *
 * The trap is the ANSWER. `askUser` returns the chosen label and callers match on it — `/^small/i.test(...)`
 * decides whether a request skips the entire spec-and-plan pipeline. Hand back a translated label and that
 * test is silently false, so the user answers correctly and the run does the other thing.
 */
describe("askInUserLanguage", () => {
  /** The other schema: this call submits {question, options}, not {text}. */
  const submitAsked = (o: unknown): ChatEvent[] => [
    { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: JSON.stringify(o) } },
    { type: "done", finishReason: "tool_calls" },
  ];
  const choices = [
    { label: "Small — just do it", description: "Straight to an implementer." },
    { label: "Full piece of work", description: "Spec, plan, tasks." },
  ];

  it("asks nothing of the model when the user works in English", async () => {
    const p = new MockProvider([]);
    let seen = "";
    const back = await askInUserLanguage(deps(p), async (q, o) => {
      seen = `${q}|${o?.options?.map((c) => c.label).join(",")}`;
      return "Small — just do it";
    }, "English", "Which is it?", choices);
    expect(p.requests.length).toBe(0);
    expect(seen).toContain("Small — just do it");
    expect(back).toBe("Small — just do it");
  });

  it("shows the translation but returns the ORIGINAL label the caller matches on", async () => {
    const p = new MockProvider([submitAsked({
      question: "Hangisi?",
      options: [
        { label: "Küçük — hemen yap", description: "Doğrudan bir uygulayıcıya." },
        { label: "Tam bir iş", description: "Spec, plan, görevler." },
      ],
    })]);
    let shown: string[] = [];
    const back = await askInUserLanguage(deps(p), async (q, o) => {
      shown = [q, ...(o?.options ?? []).map((c) => c.label)];
      return "Küçük — hemen yap";           // the user picks the Turkish label
    }, "Turkish", "Which is it?", choices);

    expect(shown[0]).toBe("Hangisi?");       // read in Turkish
    expect(shown).toContain("Küçük — hemen yap");
    expect(back).toBe("Small — just do it"); // …and the caller's /^small/i still holds
    expect(/^small/i.test(back)).toBe(true);
  });

  it("asks as written when the translation loses a choice — a half-mapped list cannot be trusted", async () => {
    const p = new MockProvider([submitAsked({ question: "Hangisi?", options: [{ label: "Küçük" }] })]);
    let shown = "";
    const back = await askInUserLanguage(deps(p), async (q) => { shown = q; return "Full piece of work"; },
      "Turkish", "Which is it?", choices);
    expect(shown).toBe("Which is it?");      // fell back rather than mapping two choices onto one
    expect(back).toBe("Full piece of work");
  });

  it("falls back to English rather than failing the question outright", async () => {
    const p = new MockProvider([[{ type: "done", finishReason: "stop" }]]);   // no submit → throws
    const back = await askInUserLanguage(deps(p), async () => "Full piece of work",
      "Turkish", "Which is it?", choices);
    expect(back).toBe("Full piece of work");
  });
});
