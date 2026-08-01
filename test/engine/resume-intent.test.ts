import { describe, it, expect } from "vitest";
import { classifyResume } from "../../src/engine/resume-intent.js";
import type { Provider } from "../../src/core/types.js";

const canned = (text: string): Provider => ({
  chat: async function* () { yield { type: "text-delta" as const, text }; },
} as unknown as Provider);
const failing = (): Provider => ({
  chat: async function* () { yield { type: "error" as const, message: "quota exhausted" }; },
} as unknown as Provider);

const run = (provider: Provider, models = ["m"]) => classifyResume({
  provider, models,
  interrupted: "Build the product-create wizard's basics step with an AI slider",
  message: "todoya ekleme. yanlış cevap verdim. sorunu düzeltmemiz gerekiyor",
});

/**
 * Resuming was matched on the request being repeated word for word, or on a bare "continue". Reported from a
 * real session: a wrong answer during brainstorming, Ctrl+C, then "don't add it to the todo, I answered
 * wrongly, we need to fix the problem" — and the pipeline restarted from the constitution, 190k tokens in.
 *
 * Neither a keyword test nor a yes/no question can read that: it is a THIRD thing — keep the work, the
 * direction was wrong, here is the right one.
 */
describe("classifyResume", () => {
  it("reads a correction as a revision, and rewrites the request to stand alone", async () => {
    const r = await run(canned('```json\n{"mode":"revise","request":"Fix the source-verification finding in the '
      + 'basics step instead of filing it as a todo","why":"You said the earlier answer was wrong."}\n```'));
    expect(r?.mode).toBe("revise");
    expect(r?.request).toContain("basics step");
    expect(r?.why).toContain("wrong");
  });

  it("reads a plain carry-on as a resume", async () => {
    const r = await run(canned('```json\n{"mode":"resume","request":"Build the wizard","why":"Nothing changed."}\n```'));
    expect(r?.mode).toBe("resume");
  });

  it("reads unrelated work as new", async () => {
    const r = await run(canned('```json\n{"mode":"new","request":"Upgrade the CI image","why":"Different subject."}\n```'));
    expect(r?.mode).toBe("new");
  });

  /** Guessing is worse than asking: "new" restarts a project, "resume" buries a real request in old work. */
  it("says nothing rather than guessing when the answer is unreadable", async () => {
    expect(await run(canned("I think it probably means resume?"))).toBeUndefined();
    expect(await run(canned('```json\n{"mode":"sideways","request":"x"}\n```'))).toBeUndefined();
    expect(await run(canned('```json\n{"mode":"revise","request":"   "}\n```'))).toBeUndefined();
  });

  it("slides past a spent model instead of losing the decision to it", async () => {
    const calls: string[] = [];
    const provider = {
      chat: async function* (req: { model: string }) {
        calls.push(req.model);
        if (req.model === "dead") { yield { type: "error" as const, message: "quota exhausted" }; return; }
        yield { type: "text-delta" as const, text: '```json\n{"mode":"resume","request":"Build the wizard","why":"ok"}\n```' };
      },
    } as unknown as Provider;
    expect((await run(provider, ["dead", "alive"]))?.mode).toBe("resume");
    expect(calls).toEqual(["dead", "alive"]);
  });

  it("gives up when the whole chain is spent — the caller asks the user", async () => {
    expect(await run(failing(), ["a", "b"])).toBeUndefined();
  });
});
