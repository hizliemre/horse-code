import { isCallerAbort, isDeadline } from "../../src/agent/deadline.js";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { promptFor, CliProvider, streamWhileRunning, isLoggedOut } from "../../src/agents/cli-provider.js";
import { cliFor, cliInvocation, cliCatalog, grokEffort } from "../../src/agents/cli-models.js";
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

  /**
   * `codex` is not a model, and passing no `--model` at all was how it used to be honoured. It named
   * nothing — 27 calls on a live board were recorded against an id that does not exist, and the Codex
   * stream never says what served. A chain written before it was removed resolves to a real name instead
   * of spending an attempt being refused.
   */
  it("always names a model, resolving the id that named none", () => {
    expect(cliInvocation("codex")).toEqual({ model: "gpt-5.6-terra" });
    expect(cliInvocation("codex-high")).toEqual({ model: "gpt-5.6-terra", effort: "high" });
    expect(cliInvocation("cx/codex")).toEqual({ model: "gpt-5.6-terra" });
  });

  it("no longer offers it as something a role can be assigned", () => {
    expect(cliCatalog()).not.toContain("codex");
    // The three tiers that DO exist were each asked for and answered.
    expect(cliCatalog()).toEqual(expect.arrayContaining(["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"]));
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
    for (const m of ["grok-4.6", "grok-4.5"]) expect(cliFor(m), m).toBe("grok");
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
   * A gateway catalog carried Grok too — `opencode-go/grok-4.5` is on this project's own record — and that
   * id names a PROXIED model this binary cannot serve. Grok arrived after the prefixes went away, so no
   * chain has ever legitimately written one, and matching loosely here would route a gateway id at the
   * local CLI and attribute the answer to a subscription that never ran it.
   */
  it("does not claim a prefixed Grok id, which belongs to a gateway", () => {
    expect(cliFor("opencode-go/grok-4.5")).toBeUndefined();
    expect(cliFor("grok/grok-4.6")).toBeUndefined();
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

  /**
   * Grok is the exception, and it is the CLI's rather than a choice: `grok models` lists `grok-4.6` and
   * `grok-4.5` and offers no alias to ask for instead. So this half of the catalog CAN go stale — and it
   * goes stale loudly, because Grok refuses an unknown name outright ("unknown model id") where Claude Code
   * answers anyway. A wrong name there fails honestly rather than inventing a turn.
   */
  it("carries Grok's versions, because Grok offers nothing else to name", () => {
    expect(cliCatalog()).toEqual(expect.arrayContaining(["grok-4.6", "grok-4.5"]));
  });
});

/**
 * Grok takes an effort, but not this system's vocabulary, and the mismatch is not harmless: an unknown level
 * ENDS the call before a model is reached. Measured by handing it a bad one — "--effort/--reasoning-effort:
 * unknown effort level 'banana'; use one of: xhigh, high, medium, low".
 */
describe("translating an effort Grok can take", () => {
  it("passes through the four levels it knows", () => {
    for (const e of ["xhigh", "high", "medium", "low"]) expect(grokEffort(e), e).toBe(e);
  });

  /**
   * `Effort` here reaches `max`, and `cliInvocation` reads a wider set of suffixes still. Left untranslated,
   * a role assigned `grok-4.6-max` would fail every call — not fall back to a default.
   */
  it("brings a level above its ceiling down, and one below its floor up", () => {
    expect(grokEffort("max")).toBe("xhigh");
    expect(grokEffort("ultra")).toBe("xhigh");
    expect(grokEffort("minimal")).toBe("low");
  });

  /** Dropped rather than guessed at: no flag means Grok's own default, which is a working call. */
  it("drops a level it cannot place", () => {
    expect(grokEffort("banana")).toBeUndefined();
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

  /**
   * Grok's `--disallowed-tools` takes ONE comma-separated value where Claude's takes separate arguments —
   * passed Claude's way, the second name would become a stray argument rather than a tool removed. The names
   * are Grok's own, read from its `system/init` tool list, and the flag was verified both ways on a real
   * call: with it the file was not created while the agent still announced it would, without it the file
   * appeared.
   */
  it("keeps a reader out of Grok's editor, in Grok's own spelling", () => {
    expect(src).toContain('this.readOnly && kind === "grok") args.push("--disallowed-tools", "write,search_replace")');
  });

  it("lets a writer write, without asking anyone", () => {
    expect(src).toContain('!this.readOnly && kind === "claude") args.push("--permission-mode", "acceptEdits")');
    expect(src).toContain('!this.readOnly && kind === "codex") args.push("--sandbox", "workspace-write")');
    expect(src).toContain('!this.readOnly && kind === "grok") args.push("--permission-mode", "acceptEdits")');
  });

  /** Neither CLI's fully permissive mode: an implementer edits its worktree, it does not reach outside it. */
  it("never asks for unrestricted access", () => {
    expect(src).not.toContain("bypassPermissions");
    expect(src).not.toContain("danger-full-access");
  });
});

/**
 * A person pressing Ctrl+C is not a model failure.
 *
 * An aborted spawn returns `{ error: "The operation was aborted", exitCode: -1 }`, and -1 is not zero — so
 * it was reported as retryable. The chain slid to the next model, started another CLI, and the ladder
 * climbed: every interrupt bought a fresh agent instead of stopping one. Reported as "I can no longer stop
 * a run with Ctrl+C".
 */
describe("a cancelled call", () => {
  it("ends the chain instead of sliding to the next model", async () => {
    const ac = new AbortController();
    ac.abort();
    const out = [];
    for await (const ev of new CliProvider({ kind: "claude" }).chat(req({ model: "haiku" }), ac.signal)) {
      out.push(ev);
    }
    const err = out.find((e) => e.type === "error");
    expect(err).toMatchObject({ type: "error", message: "cancelled", retryable: false });
  });
});

/**
 * A logged-out profile and an unrecognised model produce the SAME `<synthetic>` answer, and they call for
 * opposite remedies. Told apart wrongly, an expired login benches a model that is perfectly fine — and the
 * bench is fleet-wide, so it would be taken away from every profile that can still serve it.
 */
describe("telling a logged-out profile from a model that does not exist", () => {
  it("recognises the CLI's own words for no session", () => {
    expect(isLoggedOut("Not logged in \u00b7 Please run /login")).toBe(true);
  });

  /**
   * Grok phrases it differently AND delivers it differently: Claude answers "Not logged in" as its reply and
   * exits 0, while Grok exits 1 with no reply at all and says this on stderr. Missed, the one failure a
   * person can fix arrives as a generic CLI fault.
   */
  it("recognises Grok's wording too, which arrives as a failure rather than a reply", () => {
    expect(isLoggedOut("Error: Not signed in. To authenticate without a browser, run:\n  grok login --device-code"))
      .toBe(true);
  });

  it("does not claim a logged-out profile from an ordinary answer", () => {
    expect(isLoggedOut("ok")).toBe(false);
    expect(isLoggedOut("I logged the request and moved on")).toBe(false);
    expect(isLoggedOut("the request was signed in the header")).toBe(false);
  });
});

/**
 * A person pressing Ctrl+C and a deadline of ours running out both abort the same signal, and they call for
 * opposite answers: a cancellation ends the chain, an expired deadline is exactly when another model should
 * be tried.
 *
 * Collapsing them into "cancelled, not retryable" cost a live board 17 code-review calls, each dying at the
 * `SHORT_CALL_MS` wall with two more models left untried, and none of them anybody's Ctrl+C.
 */
describe("telling a caller's cancellation from a deadline", () => {
  const abortedWith = (reason: unknown): AbortSignal => {
    const ac = new AbortController();
    ac.abort(reason);
    return ac.signal;
  };

  it("reads a timeout as ours, not the caller's", () => {
    const s = abortedWith(new DOMException("timed out", "TimeoutError"));
    expect(isDeadline(s)).toBe(true);
    expect(isCallerAbort(s)).toBe(false);
  });

  it("reads a plain abort as the caller's", () => {
    const s = abortedWith(new DOMException("aborted", "AbortError"));
    expect(isCallerAbort(s)).toBe(true);
    expect(isDeadline(s)).toBe(false);
  });

  it("says nothing about a signal that has not aborted", () => {
    const live = new AbortController().signal;
    expect(isCallerAbort(live)).toBe(false);
    expect(isDeadline(live)).toBe(false);
  });

  /** The transport has to ASK, and it stopped asking once — which is how the two were conflated. */
  it("is what the CLI transport actually consults", () => {
    const src = readFileSync("src/agents/cli-provider.ts", "utf8");
    expect(src).toContain("if (isCallerAbort(signal))");
    expect(src).toContain("if (isDeadline(signal))");
    // A deadline must leave the chain able to try the next model.
    expect(src).toContain('message: `${kind} CLI: deadline expired`, retryable: true');
  });
});
