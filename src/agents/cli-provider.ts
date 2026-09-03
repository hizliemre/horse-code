import type { ChatEvent, ChatRequest, Provider } from "../core/types.js";
import { runCliAgent, SYNTHETIC, type CliKind, type CliUsage } from "./cli-agent.js";
import { cliFor, cliInvocation } from "./cli-models.js";

/**
 * The official CLIs behind the `Provider` seam, for every role that wants an ANSWER rather than an agent.
 *
 * Two shapes of work run through this system and only one of them needs tools. A review lens reads a diff and
 * returns findings; a judge returns a verdict; the planner returns a task list. None of them writes a file —
 * they want a structured answer, which is exactly what a headless CLI call returns. Those roles are the bulk
 * of the traffic, too: fifteen lenses per task, 53.6M of one run's 149.7M input tokens.
 *
 * The implementers are the other shape, and they do not come through here — a delegated implementer works in
 * the worktree with the CLI's OWN tools, because bridging a tool loop across a process boundary is the one
 * part of this that would have to be rebuilt rather than reused.
 *
 * How the answer gets back is the one real compromise. `runStructuredRole` normally captures a `submit` tool
 * call, and the CLI's agent cannot call a tool that lives in this process. It already has the path for this:
 * "some models emit the JSON result in prose instead of calling submit → salvage it". So the prompt asks for
 * the JSON directly and the existing salvage reads it. Second-class, but it is a road that was already built
 * and is already tested.
 */

/**
 * The conversation as one prompt.
 *
 * A headless CLI call takes a single string, so the roles have to be written into it rather than carried by
 * the request shape. Marked plainly — an unlabelled concatenation of system rules, prior turns and the
 * current ask reads as one undifferentiated wall, and the model cannot tell an instruction from a quotation.
 */
export function promptFor(req: ChatRequest): string {
  const parts: string[] = [];
  for (const m of req.messages) {
    if (m.role === "system") { parts.push(m.content); continue; }
    if (!m.content.trim()) continue;
    parts.push(m.role === "assistant" ? `[your previous reply]\n${m.content}` : m.content);
  }
  /**
   * The submit schema, asked for as prose.
   *
   * This is the bridge: the tool cannot be called across the process boundary, so the shape it would have
   * validated is stated instead and the caller's existing salvage validates the answer. Naming the tool is
   * deliberate — the schema is the contract either way, and saying which contract it is keeps the two paths
   * legible as one thing done two ways.
   */
  const submit = req.tools?.find((t) => t.name === "submit");
  if (submit) {
    parts.push(
      "Reply with ONE JSON object and nothing else — no prose before or after it, no code fence. "
      + "It must satisfy this schema:\n"
      + JSON.stringify(submit.parameters ?? {}, null, 2),
    );
  }
  return parts.join("\n\n");
}

export interface CliProviderOptions {
  /** Fixed CLI, when the caller knows which. Omitted, each request picks by its model id — see `cliFor`. */
  kind?: CliKind;
  /** Tools the delegated agent may NOT use. A role that wants an answer has no business writing files. */
  readOnly?: boolean;
}

/**
 * Yields what a callback-driven run reports, WHILE it runs.
 *
 * A generator cannot yield from inside a callback, and the first shape of this concluded it therefore had to
 * buffer: collect everything, yield after the process exits. Measured on a live run, that meant eight
 * consecutive minutes with no event of any kind, because a delegated implementation call is minutes long and
 * everything it said was being held to the end. The row a person watches was blank for the whole task.
 *
 * `waiter` is read at the await and nowhere earlier, which matters because `yield` suspends: between the
 * top of an iteration and the bottom, any number of events can arrive and the run can end. Reading the
 * freshest promise at the moment of waiting is what makes that safe. An earlier version captured it at the
 * top of the loop, on a theory about a lost wake-up — there is no such window, since nothing runs between
 * the `finished` check and the `await`, and capturing early would have meant waiting on a promise the
 * yields had already made stale.
 */
export async function* streamWhileRunning<E>(
  start: (push: (ev: E) => void) => Promise<unknown>,
): AsyncIterable<E> {
  const queue: E[] = [];
  let finished = false;
  let wake: () => void = () => {};
  let waiter = new Promise<void>((r) => { wake = r; });
  const bump = (): void => { const w = wake; waiter = new Promise<void>((r) => { wake = r; }); w(); };
  const done = start((ev) => { queue.push(ev); bump(); });
  let failure: unknown;
  void done.then(() => { finished = true; bump(); }, (e: unknown) => { failure = e; finished = true; bump(); });
  for (;;) {
    while (queue.length) yield queue.shift()!;
    if (finished) break;
    await waiter;
  }
  // Drained first, then rethrown: what the run managed to report before it failed is still worth having.
  if (failure) throw failure;
}

export class CliProvider implements Provider {
  private readonly fixed?: CliKind;
  private readonly readOnly: boolean;

  constructor(opts: CliProviderOptions = {}) {
    this.fixed = opts.kind;
    this.readOnly = opts.readOnly ?? true;
  }

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
    const kind = this.fixed ?? cliFor(req.model);
    if (!kind) {
      /**
       * Said as a model failure, so the chain slides to the next link and the bench takes this one out.
       * A role left pointing at a gateway-only source is exactly the case the fleet taxonomy handles; what
       * it must not do is silently run on some default CLI and report the answer as that model's.
       */
      yield { type: "error", message: `no CLI serves ${req.model} — it is not available in this catalog`, retryable: true };
      return;
    }
    const args: string[] = [];
    const { model, effort: named } = cliInvocation(req.model);
    // No model flag means the CLI's own default, which is what `codex` names.
    if (model) args.push("--model", model);
    /**
     * The request's own effort first, the id's suffix second.
     *
     * A Claude id names the model and nothing else, so its level travels on the request; a codex id spells
     * the level into the name (`cx/gpt-5.5-xhigh`). Reading only the name would drop every Claude role's
     * effort — the exact loss the native transport was built to stop.
     */
    const effort = req.effort ?? named;
    if (effort && kind === "claude") args.push("--effort", effort);
    /**
     * A role that was asked for a verdict must not be able to edit the tree.
     *
     * The API path enforced this by handing the role a read-only registry; here the tools belong to the CLI,
     * so the same limit has to be stated as a flag. Without it a review lens has a full editor in a worktree
     * it was only meant to read.
     */
    if (this.readOnly && kind === "claude") args.push("--disallowed-tools", "Write", "Edit", "NotebookEdit");
    if (this.readOnly && kind === "codex") args.push("--sandbox", "read-only");

    /**
     * Streamed as it happens, not replayed at the end.
     *
     * The first shape of this buffered the CLI's tool calls and yielded them after the process exited, on
     * the reasoning that a generator cannot yield from inside a callback. It can, through a queue — and the
     * difference is not cosmetic. A delegated implementation call runs for minutes: measured on a live run,
     * eight consecutive minutes with no event of any kind, because everything the CLI reported was being
     * held until it finished. The row a person watches was blank for the whole task, and the telemetry had
     * nothing to say about it either.
     */
    let res!: Awaited<ReturnType<typeof runCliAgent>>;
    yield* streamWhileRunning<ChatEvent>((push) =>
      runCliAgent({
        kind, cwd: process.cwd(), prompt: promptFor(req), signal, args,
        onEvent: (ev) => {
          if (ev.tool) push({ type: "activity", tool: ev.tool.name, ...(ev.tool.target ? { target: ev.tool.target } : {}) });
          if (ev.text) push({ type: "text-delta", text: ev.text });
        },
      }).then((r) => { res = r; }));


    /**
     * A rate limit is the fleet's, not the task's — surfaced as a retryable error so it reaches the same
     * bench the API path uses. Swallowed as text, a throttled subscription would read as a model that
     * answered with nonsense.
     */
    if (res.rateLimited) {
      yield { type: "error", message: `${kind} CLI: ${res.rateLimited}`, retryable: true };
      return;
    }
    /**
     * A name the CLI did not recognise produces an answer anyway — and it is not a model's.
     *
     * Claude Code does not validate `--model`: a bogus name exits 0 with `subtype: "success"` and text that
     * reads like a reply, while `message.model` says `<synthetic>`. Passed on, horse-code would record a
     * fabricated turn as that model's work — the fitness store learning from it, a review counting it, a
     * role judged on a turn that never happened. Retryable, so the chain slides and the bench removes the
     * name that cannot be served.
     */
    if (res.served === SYNTHETIC) {
      yield {
        type: "error", retryable: true,
        message: `${kind} CLI did not recognise ${req.model} and answered without a model`,
      };
      return;
    }
    if (res.error && !res.text.trim()) {
      yield { type: "error", message: `${kind} CLI: ${res.error}`, retryable: res.exitCode !== 0 };
      return;
    }
    if (res.usage) yield usageEvent(res.usage);
    yield { type: "done", finishReason: "stop" };
  }
}

/** The CLI's own accounting, in this system's shape — so a CLI run and an API run compare like for like. */
function usageEvent(u: CliUsage): ChatEvent {
  return {
    type: "usage",
    promptTokens: u.freshTokens,
    completionTokens: u.outputTokens,
    cachedTokens: u.cachedTokens,
    cacheWriteTokens: u.cacheWriteTokens,
  };
}
