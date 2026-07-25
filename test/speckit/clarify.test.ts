import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClarify } from "../../src/speckit/clarify.js";
import { scaffoldFeature } from "../../src/speckit/layout.js";
import { MockProvider } from "../../src/providers/mock.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { ChatEvent, Provider } from "../../src/core/types.js";
import type { SpecKitTemplates } from "../../src/speckit/templates.js";
import type { TaskCycleDeps } from "../../src/engine/task-types.js";

const templates: SpecKitTemplates = { version: "t", template: () => "T", command: () => "C" };
function deps(p: MockProvider): TaskCycleDeps {
  return {
    provider: p,
    roleRegistry: new RoleRegistry({ analyst: { models: ["m"], systemPrompt: "a" } }, {}, new SkillRegistry()),
    skillRegistry: new SkillRegistry(),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: new AbortController().signal,
    specKit: () => Promise.resolve(templates),
  };
}
const ask = (q: string | null): ChatEvent[] => [
  { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: JSON.stringify({ nextQuestion: q }) } },
  { type: "done", finishReason: "tool_calls" },
];

let wd: string;
beforeEach(async () => { wd = await mkdtemp(join(tmpdir(), "hc-cl-")); });
afterEach(async () => { await rm(wd, { recursive: true, force: true }); });

describe("runClarify", () => {
  it("asks questions one at a time; the user's answers reach the model; stops on null", async () => {
    const paths = scaffoldFeature(wd, "001-x");
    await writeFile(paths.spec, "# Spec", "utf8");
    const p = new MockProvider([ask("Which DB?"), ask(null)]);
    const asked: string[] = [];
    await runClarify(
      { deps: deps(p), templates, workdir: wd, askUser: async (q) => { asked.push(q); return "Postgres"; } },
      paths,
    );
    expect(asked).toEqual(["Which DB?"]);
    // the answer was fed back into the second turn's context
    expect(JSON.stringify(p.requests[1].messages)).toContain("Postgres");
  });

  it("stops after maxRounds even if the model keeps asking", async () => {
    const paths = scaffoldFeature(wd, "001-x");
    await writeFile(paths.spec, "# Spec", "utf8");
    const p = new MockProvider([ask("q1"), ask("q2"), ask("q3")]);
    let n = 0;
    await runClarify(
      { deps: deps(p), templates, workdir: wd, askUser: async () => { n++; return "a"; } },
      paths,
      2,
    );
    expect(n).toBe(2); // capped
  });
});

describe("answers that were never written into the spec", () => {
  it("does a final write-back pass so the user's answers are not lost", async () => {
    const paths = scaffoldFeature(wd, "001-x");
    await writeFile(paths.spec, "# Spec", "utf8");
    // The role asks one question, then says it is done — but never touches the spec file.
    let recovery = 0;
    const seen: string[] = [];
    const p: Provider & { requests: unknown[] } = {
      requests: [],
      async *chat(req) {
        const convo = req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
        seen.push(convo);
        if (convo.includes("NOT written into the spec")) { // the recovery pass
          recovery++;
          yield { type: "text-delta", text: "updated" };
          yield { type: "done", finishReason: "stop" };
          return;
        }
        const asked = seen.filter((c) => !c.includes("NOT written")).length;
        yield { type: "tool-call", toolCall: { id: "s", name: "submit", arguments: `{"nextQuestion":${asked === 1 ? '"Retention?"' : "null"}}` } };
        yield { type: "done", finishReason: "tool_calls" };
      },
    };
    await runClarify({ deps: deps(p as never), templates, workdir: wd, askUser: async () => "30 days" }, paths);
    expect(recovery).toBe(1);                       // the answers were written back, not dropped
    expect(seen.join("\n")).toContain("30 days");   // …and the recovery pass carried them
  });
});
