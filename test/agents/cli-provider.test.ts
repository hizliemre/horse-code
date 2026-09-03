import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { promptFor, CliProvider, streamWhileRunning } from "../../src/agents/cli-provider.js";
import { cliFor, cliInvocation, cliCatalog } from "../../src/agents/cli-models.js";
import type { ChatRequest } from "../../src/core/types.js";
import { makeStreamReader, decodeClaudeEvent } from "../../src/agents/cli-agent.js";

const req = (over: Partial<ChatRequest> = {}): ChatRequest =>
  ({ model: "opus", messages: [{ role: "user", content: "hi" }], tools: [], ...over });

/**
 * One horse-code id means two things — a family and how hard to work — and the CLIs take them separately.
 *
 * `codex` is the exception worth stating: it names the CLI's own DEFAULT, expressed by passing no model
 * flag at all. Returning a name there would ask Codex for a model called "codex".
 */
describe("splitting an id into a model and an effort", () => {
  it("separates the family from the level", () => {
    expect(cliInvocation("opus-high")).toEqual({ model: "opus", effort: "high" });
    expect(cliInvocation("sonnet")).toEqual({ model: "sonnet" });
    expect(cliInvocation("gpt-5.6-terra-medium")).toEqual({ model: "gpt-5.6-terra", effort: "medium" });
  });

  it("asks for no model when the id names the CLI's default", () => {
    expect(cliInvocation("codex")).toEqual({});
    expect(cliInvocation("codex-high")).toEqual({ effort: "high" });
  });

  /** A chain written before the prefixes went away must keep working rather than fail for nothing. */
  it("still reads an id that carries an old source prefix", () => {
    expect(cliInvocation("cc/opus-low")).toEqual({ model: "opus", effort: "low" });
    expect(cliInvocation("no-think/cx/gpt-5.6-sol")).toEqual({ model: "gpt-5.6-sol" });
  });
});

/**
 * Which CLI serves a model, read from the name now that nothing carries a prefix.
 *
 * A prefix was the gateway's way of naming a subscription to bill; with one binary per family the name
 * already says it. Anything unrecognised must fail rather than be guessed at — served quietly by a default,
 * the answer would be attributed to a model that never ran.
 */
describe("choosing a CLI from the model name", () => {
  it("routes each family to its binary", () => {
    for (const m of ["fable", "opus", "sonnet", "haiku"]) expect(cliFor(m), m).toBe("claude");
    for (const m of ["codex", "gpt-5.6-terra", "gpt-5.6-sol"]) expect(cliFor(m), m).toBe("codex");
  });

  it("still routes an id left over from the prefixed era", () => {
    expect(cliFor("cc/claude-opus-5")).toBe("claude");
    expect(cliFor("no-think/cx/gpt-5.5")).toBe("codex");
  });

  it("refuses a name nothing serves", () => {
    expect(cliFor("antigravity/claude-sonnet-4-6")).toBeUndefined();
    expect(cliFor("opencode-go/hy3")).toBeUndefined();
  });

  /**
   * The catalog holds no dates and no version numbers, which is what stops it going stale.
   *
   * Measured, and the reason families won: `fable` served `claude-fable-5-1` — the model that returned 404
   * through the gateway, whose own resolution of `claude-fable-5` pointed at a name that did not exist.
   */
  it("names families, never versions", () => {
    for (const m of cliCatalog()) {
      expect(m, m).not.toMatch(/\d{6,}/);
      expect(m, m).not.toMatch(/-\d+-\d+$/);
    }
  });
});

/**
 * A headless call takes ONE string, so the message roles have to be written into it. An unlabelled
 * concatenation reads as one wall of text and the model cannot tell an instruction from a quotation.
 */
describe("folding a conversation into one prompt", () => {
  it("keeps the turns apart and marks whose is whose", () => {
    const p = promptFor(req({ messages: [
      { role: "system", content: "you are a reviewer" },
      { role: "user", content: "review this" },
      { role: "assistant", content: "I found one thing" },
      { role: "user", content: "and the tests?" },
    ] }));
    expect(p).toContain("you are a reviewer");
    expect(p).toContain("[your previous reply]\nI found one thing");
    expect(p.indexOf("review this")).toBeLessThan(p.indexOf("and the tests?"));
  });

  /**
   * The bridge for a structured role: the `submit` tool cannot be called across a process boundary, so the
   * shape it would have validated is stated instead and the caller's existing JSON salvage validates it.
   */
  it("states the submit schema when the role has one", () => {
    const schema = { type: "object", properties: { verdict: { type: "string" } } };
    const p = promptFor(req({ tools: [{ name: "submit", description: "d", parameters: schema }] }));
    expect(p).toContain("ONE JSON object");
    expect(p).toContain('"verdict"');
  });

  it("says nothing about JSON for a role that has no submit", () => {
    expect(promptFor(req())).not.toContain("ONE JSON object");
  });

  /** An empty turn contributes nothing but a blank gap — the prompt is already long enough. */
  it("skips empty turns", () => {
    const p = promptFor(req({ messages: [{ role: "user", content: "  " }, { role: "user", content: "real" }] }));
    expect(p.trim()).toBe("real");
  });
});

/** …and the refusal reaches the chain as a model failure, so the bench and the fallback both apply. */
describe("a model with no CLI", () => {
  it("errors retryably instead of running on whichever CLI was default", async () => {
    const p = new CliProvider();
    const out = [];
    for await (const ev of p.chat(req({ model: "antigravity/claude-sonnet-4-6" }), new AbortController().signal)) {
      out.push(ev);
    }
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "error", retryable: true });
    expect(out[0].type === "error" && out[0].message).toMatch(/no CLI serves/);
  });
});

/**
 * A delegated agent showed "starting up…" for its whole life.
 *
 * The live row's activity line reads the tool calls this process's executor recorded, and a delegated agent
 * runs its tools in another one — so the row said nothing while its clock and token count climbed beside it.
 * That row is the one thing a person watches to know what is happening.
 *
 * The provider knows WHAT was done; the loop knows WHO did it, because the implementer binds the sink to its
 * card. So the provider reports the call and the loop attributes it.
 */
describe("reporting what the CLI's own agent did", () => {
  it("turns the CLI's tool calls into activity events", async () => {
    const events: string[] = [];
    const stream = [
      '{"type":"assistant","message":{"model":"claude-opus-5","content":[{"type":"tool_use","id":"t1",'
        + '"name":"Write","input":{"file_path":"src/a.ts"}}]}}',
      '{"type":"assistant","message":{"model":"claude-opus-5","content":[{"type":"text","text":"done"}]}}',
      '{"type":"result","subtype":"success","usage":{"input_tokens":1,"output_tokens":1}}',
    ].join("\n");
    const reader = makeStreamReader(decodeClaudeEvent, (ev) => { if (ev.tool) events.push(`${ev.tool.name}:${ev.tool.target}`); });
    reader.push(stream); reader.end();
    expect(events).toEqual(["Write:src/a.ts"]);
  });
});

/**
 * A delegated call is minutes long, and everything it reports must arrive WHILE it is happening.
 *
 * The first shape of this buffered: collect everything the CLI reports, yield after the process exits, on
 * the reasoning that a generator cannot yield from inside a callback. Measured on a live run — eight
 * consecutive minutes with no event of any kind, because a delegated implementation call runs that long and
 * everything it said was being held to the end. The row a person watches was blank for the whole task.
 */
describe("streaming what a run reports while it runs", () => {
  const collect = async (it: AsyncIterable<number>) => {
    const out: number[] = [];
    for await (const v of it) out.push(v);
    return out;
  };

  it("yields each event as it is pushed, not in a batch at the end", async () => {
    const seenAt: number[] = [];
    const t0 = Date.now();
    for await (const v of streamWhileRunning<number>(async (push) => {
      push(1); await new Promise((r) => setTimeout(r, 20));
      push(2); await new Promise((r) => setTimeout(r, 20));
      push(3);
    })) { seenAt.push(Date.now() - t0); void v; }
    expect(seenAt).toHaveLength(3);
    // The first arrived while the run still had 40ms of work left — not batched at the end.
    expect(seenAt[0]).toBeLessThan(seenAt[2] - 20);
  });

  /**
   * The termination cases, which is where a stream bridge hangs if it hangs at all.
   *
   * A run that reports nothing and returns immediately is the sharpest of them: there is no event to wake
   * the loop, only the completion, so the loop has to notice that on its own.
   */
  it("ends when the run ends, even with nothing pushed", async () => {
    const finished = await Promise.race([
      collect(streamWhileRunning<number>(async () => { /* reports nothing at all */ })).then(() => "done"),
      new Promise((r) => setTimeout(() => r("HUNG"), 500)),
    ]);
    expect(finished).toBe("done");
  });

  it("ends when the run finishes in the same tick as its last push", async () => {
    const finished = await Promise.race([
      collect(streamWhileRunning<number>(async (push) => { push(1); push(2); })).then((v) => v.join(",")),
      new Promise((r) => setTimeout(() => r("HUNG"), 500)),
    ]);
    expect(finished).toBe("1,2");
  });

  /** What the run managed to report before it failed is still worth having, so it drains before it throws. */
  it("yields what was pushed, then rethrows the failure", async () => {
    const seen: number[] = [];
    await expect((async () => {
      for await (const v of streamWhileRunning<number>(async (push) => {
        push(7);
        await new Promise((r) => setTimeout(r, 5));
        throw new Error("the CLI died");
      })) seen.push(v);
    })()).rejects.toThrow("the CLI died");
    expect(seen).toEqual([7]);
  });
});

/**
 * What a delegated agent is allowed to do, stated as flags because the tools belong to the CLI.
 *
 * The API path enforced this by handing a role a read-only registry. Here the limit has to be restated, and
 * in both directions: a review lens with a full editor in a tree it was only meant to read is one failure,
 * and an implementer that stalls at a permission prompt nobody will answer is the other — a headless run has
 * no one at the keyboard, so it simply waits until its deadline.
 */
describe("what a delegated agent may do", () => {
  const src = readFileSync("src/agents/cli-provider.ts", "utf8");

  it("keeps a reader out of the editor", () => {
    expect(src).toContain('this.readOnly && kind === "claude") args.push("--disallowed-tools"');
    expect(src).toContain('this.readOnly && kind === "codex") args.push("--sandbox", "read-only")');
  });

  it("lets a writer write, without asking anyone", () => {
    expect(src).toContain('!this.readOnly && kind === "claude") args.push("--permission-mode", "acceptEdits")');
    expect(src).toContain('!this.readOnly && kind === "codex") args.push("--sandbox", "workspace-write")');
  });

  /** Neither CLI's fully permissive mode: an implementer edits its worktree, it does not reach outside it. */
  it("never asks for unrestricted access", () => {
    expect(src).not.toContain("bypassPermissions");
    expect(src).not.toContain("danger-full-access");
  });
});
