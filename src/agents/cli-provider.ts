import type { ChatEvent, ChatRequest, Provider } from "../core/types.js";
import { runCliAgent, SYNTHETIC, type CliKind, type CliUsage } from "./cli-agent.js";
import { isCallerAbort, isDeadline } from "../agent/deadline.js";
import { AccountPool } from "./cli-accounts.js";
import { cliFor, cliInvocation, grokEffort } from "./cli-models.js";

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

/**
 * The answer of a CLI whose profile has no session.
 *
 * Measured against the real binaries, and they say it differently enough that one wording would miss:
 *
 *   claude  a call under a `CLAUDE_CONFIG_DIR` never logged into exits 0, reports `<synthetic>` for the
 *           model, and says exactly "Not logged in · Please run /login" as its ANSWER.
 *   grok    a call under a fresh `GROK_HOME` exits 1 with an empty answer and says it on STDERR:
 *           "Error: Not signed in. To authenticate without a browser, run: grok login --device-code".
 *
 * Which is why this reads a string rather than a stream: on one CLI the sentence arrives as the reply, on
 * the other as the failure.
 */
export function isLoggedOut(text: string): boolean {
  return /not logged in|not signed in|please run \/login/i.test(text);
}

export interface CliProviderOptions {
  /** Fixed CLI, when the caller knows which. Omitted, each request picks by its model id — see `cliFor`. */
  kind?: CliKind;
  /** Tools the delegated agent may NOT use. A role that wants an answer has no business writing files. */
  readOnly?: boolean;
  /**
   * Where the CLI runs — a task's worktree, not this process's directory.
   *
   * The default is `process.cwd()`, which is right for a role that only reads and wrong for anything that
   * writes: an implementer left on it would edit horse-code's own checkout instead of the worktree its task
   * was derived into. Every writing caller passes this.
   */
  cwd?: string;
  /**
   * The logged-in profiles to spill across. Omitted, calls run under the ambient login.
   *
   * The pool holds both CLIs' profiles and hands out only the kind being called: a Claude profile says
   * nothing about a Codex subscription, and offering one to the other would point a binary at a directory
   * belonging to something else entirely.
   */
  accounts?: AccountPool;
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
  private readonly cwd?: string;
  private readonly accounts?: AccountPool;

  constructor(opts: CliProviderOptions = {}) {
    this.fixed = opts.kind;
    this.readOnly = opts.readOnly ?? true;
    this.cwd = opts.cwd;
    this.accounts = opts.accounts;
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
    /**
     * z.ai takes Claude Code's flag because it IS Claude Code. Measured against a stand-in endpoint,
     * `--effort high` produced no visible difference in the request body — both with and without it the
     * body carried `thinking: {type: "adaptive"}` — so this is passed for consistency with the Claude path
     * and not because it was seen to change anything on the wire.
     */
    if (effort && (kind === "claude" || kind === "zai")) args.push("--effort", effort);
    /**
     * Grok takes an effort too, but not this system's vocabulary — see `grokEffort`. A level it does not
     * know is an ERROR that ends the call before a model is reached, so it is translated rather than passed,
     * and dropped rather than guessed at when nothing corresponds.
     */
    if (effort && kind === "grok") {
      const level = grokEffort(effort);
      if (level) args.push("--reasoning-effort", level);
    }
    /**
     * A role that was asked for a verdict must not be able to edit the tree.
     *
     * The API path enforced this by handing the role a read-only registry; here the tools belong to the CLI,
     * so the same limit has to be stated as a flag. Without it a review lens has a full editor in a worktree
     * it was only meant to read.
     */
    if (this.readOnly && (kind === "claude" || kind === "zai")) args.push("--disallowed-tools", "Write", "Edit", "NotebookEdit");
    if (this.readOnly && kind === "codex") args.push("--sandbox", "read-only");
    /**
     * Grok's is the same idea in its own spelling, and the spelling is the trap: its `--disallowed-tools`
     * takes ONE comma-separated value, where Claude's takes a list of separate arguments. Passed Claude's
     * way, the second name becomes the prompt's neighbour rather than a tool to remove.
     *
     * The names are Grok's own, read from the `system/init` event's tool list rather than assumed:
     * `write` creates a file and `search_replace` edits one. Verified both ways on a real call — with the
     * flag no file was created (while the agent still announced it would), without it the file appeared.
     *
     * `run_terminal_command` is deliberately left available, matching the Claude side, where Bash is not
     * among the disallowed tools either: a lens that cannot read the tree cannot review it. Asked to write
     * anyway, Grok DOES reach for it — "I don't have a dedicated write tool in this session, so I'll create
     * blocked.txt with the terminal" — and still produced no file, because a read-only call passes no
     * `--permission-mode` and its default refuses the write. Measured, not assumed; and it is the shell, not
     * the flag, doing the refusing there.
     */
    if (this.readOnly && kind === "grok") args.push("--disallowed-tools", "write,search_replace");
    /**
     * A writing agent has to be allowed to write, and nobody is there to be asked.
     *
     * A headless run has no one at the keyboard, so a CLI that pauses for permission simply stalls until its
     * deadline. `acceptEdits` and `workspace-write` are the narrowest settings that let the work happen:
     * both confine it to the directory the call runs in, which is the task's own worktree — derived for this
     * task, thrown away after it, and never the developer's checkout.
     *
     * Deliberately NOT the fully permissive settings either CLI offers. An implementer needs to edit its
     * worktree, not to reach outside it.
     */
    if (!this.readOnly && (kind === "claude" || kind === "zai")) args.push("--permission-mode", "acceptEdits");
    if (!this.readOnly && kind === "codex") args.push("--sandbox", "workspace-write");
    // Grok spells this exactly as Claude does, and its `--permission-mode` list offers a fully permissive
    // setting too — deliberately not taken here, for the reason above.
    if (!this.readOnly && kind === "grok") args.push("--permission-mode", "acceptEdits");

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
    /**
     * Which subscription serves this call, decided per call rather than per run.
     *
     * Per call is what makes it spillover: the reading that moves a run onto the next profile arrives WITH a
     * call, so the very next one can act on it. Decided once at startup, a run would keep pushing into a
     * limit it had already been told about.
     */
    const account = this.accounts?.pick(kind);

    let res!: Awaited<ReturnType<typeof runCliAgent>>;
    yield* streamWhileRunning<ChatEvent>((push) =>
      runCliAgent({
        kind, cwd: this.cwd ?? process.cwd(), prompt: promptFor(req), signal, args,
        ...(account ? { configDir: account.configDir } : {}),
        onEvent: (ev) => {
          if (ev.tool) push({ type: "activity", tool: ev.tool.name, ...(ev.tool.target ? { target: ev.tool.target } : {}), ...(ev.tool.ok === false ? { ok: false } : {}) });
          if (ev.text) push({ type: "text-delta", text: ev.text });
          // Every call carries one of these, so the pool learns what this profile has left at no extra cost.
          if (ev.quota && account) this.accounts?.record(kind, account.name, ev.quota.windows);
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
      /**
       * A profile with no session answers the same way, and the remedy is the opposite one.
       *
       * Measured: a call under a `CLAUDE_CONFIG_DIR` that was never logged into exits 0, reports
       * `<synthetic>`, and its whole answer is "Not logged in · Please run /login". Reported as an
       * unrecognised model it would bench a model that is perfectly fine — and the bench is fleet-wide, so
       * one expired login would take that model away from every profile that CAN still serve it. Sessions do
       * expire, so this path is not hypothetical.
       */
      const loggedOut = isLoggedOut(res.text);
      yield {
        type: "error", retryable: true,
        message: loggedOut
          ? `${kind} CLI is not logged in${account ? ` under profile "${account.name}"` : ""} — run \`hcode add-provider ${kind}\` to sign it in again`
          : `${kind} CLI did not recognise ${req.model} and answered without a model`,
      };
      return;
    }
    /**
     * A person pressing Ctrl+C is not a model failure, and calling it one made the run unstoppable.
     *
     * An aborted spawn comes back as `{ error: "The operation was aborted", exitCode: -1 }`, and -1 is not
     * zero — so it was reported as RETRYABLE. The chain slid to the next model, started another CLI, and the
     * ladder climbed: every interrupt bought a fresh agent instead of stopping one. Reported as "I can no
     * longer stop a run with Ctrl+C", and correctly.
     *
     * The old transport drew this line and this one had lost it: a caller's cancellation ends the call, and
     * nothing about it says another model would do better.
     */
    /**
     * A person pressing Ctrl+C and a deadline of ours running out both abort this signal, and they call for
     * opposite answers. Collapsing them into "cancelled, not retryable" — which this did — made every
     * expired deadline end its chain instead of sliding to the next model.
     *
     * Measured on a live board: 17 code-review calls died at exactly 180_433ms and upward, all of them the
     * `SHORT_CALL_MS` budget expiring, none of them anybody's Ctrl+C. Each one ended a chain that had two
     * more models to try.
     *
     * The gateway transport drew this line and this one had to be taught it again — see `isCallerAbort`.
     */
    if (isCallerAbort(signal)) {
      yield { type: "error", message: "cancelled", retryable: false };
      return;
    }
    if (isDeadline(signal)) {
      yield { type: "error", message: `${kind} CLI: deadline expired`, retryable: true };
      return;
    }
    if (res.error && !res.text.trim()) {
      /**
       * A missing session is worth naming as one, whichever way the CLI phrased it.
       *
       * The `<synthetic>` branch above catches it on Claude, where a signed-out profile still ANSWERS. Grok
       * fails instead — exit 1, no answer, the sentence on stderr — so it arrives here, and passed through
       * raw it reads as some transient CLI fault. It is not transient: nothing about this call will work
       * until somebody signs in, and the remedy is one command.
       */
      if (isLoggedOut(res.error)) {
        yield {
          type: "error", retryable: true,
          message: `${kind} CLI is not logged in${account ? ` under profile "${account.name}"` : ""} — run \`hcode add-provider ${kind}\` to sign it in again`,
        };
        return;
      }
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
