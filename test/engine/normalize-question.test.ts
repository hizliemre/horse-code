import { describe, it, expect } from "vitest";
import { looksLikeChoices, normalizeQuestion } from "../../src/engine/normalize-question.js";
import { buildAskUserTool } from "../../src/engine/writer-registry.js";
import { MockProvider } from "../../src/providers/mock.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import type { ChatEvent } from "../../src/core/types.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";

const ctx = { cwd: ".", signal: new AbortController().signal };
function submit(obj: unknown): ChatEvent[] {
  return [{ type: "tool-call", toolCall: { id: "s", name: "submit", arguments: JSON.stringify(obj) } }, { type: "done", finishReason: "tool_calls" }];
}
function deps(p: MockProvider): TaskCycleDeps {
  return {
    provider: p,
    roleRegistry: new RoleRegistry({ refiner: { models: ["m"], systemPrompt: "P" } }, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: new AbortController().signal,
    specKit: async () => ({ command: () => "" } as never),
  };
}

describe("looksLikeChoices", () => {
  it("flags markdown tables, lettered/bullet lists, and 'recommended/seçenek'", () => {
    expect(looksLikeChoices("| A | Web app |\n| B | Desktop |")).toBe(true);
    expect(looksLikeChoices("Pick one:\nA) Web\nB) Desktop\nC) Mobile")).toBe(true);
    expect(looksLikeChoices("- Web app\n- Desktop app")).toBe(true);
    expect(looksLikeChoices("Önerilen: Seçenek A (web).")).toBe(true);
  });
  it("does NOT flag a plain open-ended question", () => {
    expect(looksLikeChoices("What is the API base URL?")).toBe(false);
    expect(looksLikeChoices("Describe the target users.")).toBe(false);
  });
});

describe("normalizeQuestion", () => {
  it("extracts {question, options, multiSelect} from an embedded-choices question via a fast model", async () => {
    const p = new MockProvider([submit({ question: "Which platform?", options: ["Web (recommended)", "Desktop", "Mobile"], multiSelect: false })]);
    const n = await normalizeQuestion(deps(p), "Which platform?\n| A | Web |\n| B | Desktop |\n| C | Mobile |\nRecommended: A");
    expect(n.question).toBe("Which platform?");
    expect(n.options).toEqual(["Web (recommended)", "Desktop", "Mobile"]);
    expect(n.multiSelect).toBe(false);
  });
});

describe("buildAskUserTool with normalize", () => {
  const capture = () => { const seen: { q: string; opts?: (string | { label: string })[] }[] = []; return { seen, ask: async (q: string, o?: { options?: (string | { label: string })[] }) => { seen.push({ q, opts: o?.options }); return "answer"; } }; };

  /**
   * A question that already lists its choices is READ, not sent to a model: the structuring work is done,
   * and paying a call to restate it added a delay and a silent failure mode.
   */
  it("embedded choices + no options → the list is read without a model", async () => {
    const { seen, ask } = capture();
    let normalized = 0;
    const tool = buildAskUserTool(ask, async () => { normalized++; return { question: "x", options: ["a"], multiSelect: false }; });
    await tool.run({ question: "Which platform?\n| A | Web |\n| B | Desktop |" }, ctx);
    expect(normalized).toBe(0);
    expect(seen[0].opts).toEqual([{ label: "A", description: "Web" }, { label: "B", description: "Desktop" }]);
  });

  /** Printing the table AND the list makes the reader check whether the two differ. */
  it("removes the consumed list from the question", async () => {
    const { seen, ask } = capture();
    await buildAskUserTool(ask).run({ question: "Which platform?\n| A | Web |\n| B | Desktop |" }, ctx);
    expect(seen[0].q).toBe("Which platform?");
  });

  it("falls back to a model only when the choices are hidden in prose", async () => {
    const { seen, ask } = capture();
    let normalized = 0;
    const normalize = async () => {
      normalized++;
      return { question: "Which platform?", options: ["Web (recommended)", "Desktop"], multiSelect: false };
    };
    await buildAskUserTool(ask, normalize)
      .run({ question: "Should we choose the web option or the desktop one? Recommended: web." }, ctx);
    expect(normalized).toBe(1);
    expect(seen[0].opts).toEqual(["Web (recommended)", "Desktop"]);
  });

  it("a plain question → normalize NOT invoked, asked as free-text", async () => {
    const { seen, ask } = capture();
    let normalized = 0;
    const tool = buildAskUserTool(ask, async () => { normalized++; return { question: "x", options: ["a"], multiSelect: false }; });
    await tool.run({ question: "What is the API base URL?" }, ctx);
    expect(normalized).toBe(0); // gated by looksLikeChoices
    expect(seen[0].opts).toBeUndefined();
  });

  it("structured options already passed → normalize NOT invoked", async () => {
    const { seen, ask } = capture();
    let normalized = 0;
    const tool = buildAskUserTool(ask, async () => { normalized++; return { question: "x", options: ["a"], multiSelect: false }; });
    await tool.run({ question: "Pick:\nA) one\nB) two", options: ["one", "two"] }, ctx);
    expect(normalized).toBe(0);
    expect(seen[0].opts).toEqual(["one", "two"]);
  });

  it("normalizer returns no options / throws → falls back to the raw question", async () => {
    const { seen, ask } = capture();
    // Prose the reader cannot structure either — nothing to extract, so the model is the only hope.
    const prose = "Which option do you recommend here, and why is it better than the alternative?";
    const tool = buildAskUserTool(ask, async () => ({ question: "x", options: [], multiSelect: false }));
    await tool.run({ question: prose }, ctx);
    expect(seen[0].q).toBe(prose); // raw question, no options extracted
    expect(seen[0].opts).toBeUndefined();

    const t2 = buildAskUserTool(ask, async () => { throw new Error("boom"); });
    await t2.run({ question: prose }, ctx);
    expect(seen[1].q).toBe(prose); // normalizer threw → raw question
  });
});
