import { spawn } from "node:child_process";

/**
 * Running an official coding CLI as the agent, instead of calling a model API.
 *
 * The gateway route is not available: routing a Claude subscription through a proxy is outside its terms and
 * the account was suspended for it. The official clients ARE built for this — both ship a documented headless
 * mode — and they run under the user's own credentials, on the user's own machine.
 *
 * What that buys and what it costs, measured against the real binaries rather than assumed:
 *
 *   claude -p --output-format stream-json --verbose
 *     system/init · assistant (with full usage) · rate_limit_event · result/success
 *     → usage, cost, the rate-limit signal and the session id all come back, so the bench/park machinery
 *       and the telemetry keep working. This was the main worry about delegating, and it does not hold.
 *
 *   codex exec --json
 *     the same shape in Codex's own vocabulary.
 *
 * The fixed cost of one delegated conversation is ~18.5k cache-write tokens (~$0.19 API-equivalent) — the
 * project's CLAUDE.md, hooks and skills being loaded. Measured across every arrangement of the prompt:
 * appending to the system prompt, replacing it, putting everything in the user message, and turning the
 * system-prompt snapshot on. All landed within a few hundred tokens of each other, so there is no clever
 * shape to find: it is what a fresh session of that project costs. On a subscription it counts against the
 * usage limit rather than a bill, and it is small next to the work itself.
 *
 * One arrangement DOES matter, and it is why the prompt goes in the user message: horse-code owns memory.
 * Hints are composed per task and injected as the message, exactly as they are on the API path, so nothing
 * about recall or crediting changes with the transport.
 */

/** Which official CLI runs the agent. */
export type CliKind = "claude" | "codex";

export interface CliEvent {
  /** Assistant prose as it arrives — the live row and the transcript read this. */
  text?: string;
  /**
   * A tool the CLI's own agent used. Reported for the activity strip; horse-code does not execute it.
   *
   * `ok` is false when the CLI reported the call as an error — a denied write, a failed command. Without it
   * the row shows what the agent ASKED for and calls it done: measured, a write refused with "Claude
   * requested permissions to edit … which is a sensitive file" appeared as `Write hello.txt` while no file
   * was created. An attempt and an outcome are not the same claim.
   */
  tool?: { name: string; target?: string; ok?: boolean };
  /** Terminal usage for the whole run. */
  usage?: CliUsage;
  /** The CLI REFUSED the call for quota. Mapped onto the same bench the API path uses. */
  rateLimited?: string;
  /** How much of each usage window is spent. Reported on every call, refused or not — see `decodeClaudeEvent`. */
  quota?: CliQuota;
  /** A failure the CLI reported, verbatim. */
  error?: string;
  /** The model that ACTUALLY served the turn, as the CLI names it — see `SYNTHETIC`. */
  served?: string;
}

/**
 * What the subscription has left, as the CLI reports it on every call.
 *
 * `rate_limit_event` is quota TELEMETRY, not a failure: a successful call carries one too, with
 * `status: "allowed"` and the utilization of each window. Read as an error — which it was, until a live call
 * came back refused for no reason — every single call aborts. Read properly it is the one thing a
 * subscription-backed run most needs: how close the limit is, before it is hit rather than after.
 */
export interface CliQuota {
  /** The CLI's own word: "allowed" means this call went through. */
  status: string;
  /** Fraction of each named window already spent, e.g. `{ five_hour: 0.27, seven_day: 0.05 }`. */
  windows: Record<string, number>;
  /** When the window that is furthest along resets, in epoch seconds. */
  resetsAt?: number;
}

export interface CliUsage {
  freshTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** The CLI's own API-equivalent figure. On a subscription this is a usage measure, not a bill. */
  costUsd?: number;
}

export interface CliRun {
  kind: CliKind;
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  /** Extra arguments the caller wants, e.g. `--add-dir`. Never credentials. */
  args?: string[];
  /**
   * Which logged-in profile runs this call — a directory, not a credential.
   *
   * Claude Code keeps its session under a config directory, and `CLAUDE_CONFIG_DIR` chooses which one.
   * Verified: pointed at a fresh directory it answers "Not logged in · Please run /login" and builds its own
   * tree there, so a second subscription is a second directory that has been logged into once, by hand.
   *
   * Nothing about a credential passes through here. horse-code names a profile; the CLI reads its own
   * session from it, exactly as it does when a person runs it.
   */
  configDir?: string;
  onEvent?: (ev: CliEvent) => void;
}

export interface CliResult {
  text: string;
  usage?: CliUsage;
  rateLimited?: string;
  quota?: CliQuota;
  /** The model that actually served the turn. `SYNTHETIC` means none did — see the constant. */
  served?: string;
  error?: string;
  exitCode: number;
}

/** The argv for a headless run, per CLI. Kept in one place so the two shapes can be read side by side. */
export function cliArgs(kind: CliKind, prompt: string, extra: string[] = []): string[] {
  return kind === "claude"
    // `--verbose` is required for stream-json to emit the per-turn events rather than only the result.
    ? ["-p", prompt, "--output-format", "stream-json", "--verbose", ...extra]
    // `--skip-git-repo-check`: a task worktree IS a repo, but the base and the scratch cases are not, and
    // Codex refuses outright rather than degrading — measured: "Not inside a trusted directory".
    : ["exec", "--json", "--skip-git-repo-check", prompt, ...extra];
}

/**
 * Claude Code's stream-json, decoded into this system's vocabulary.
 *
 * Only the fields that carry meaning here: the assistant's text, the tools its agent ran (for the activity
 * strip), the terminal usage, and the rate-limit signal — which is the one the whole bench/park machinery is
 * built around, so it must not be swallowed as an unknown event type.
 */
export function decodeClaudeEvent(line: string): CliEvent | undefined {
  let e: Record<string, unknown>;
  try { e = JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
  const type = e.type;
  if (type === "rate_limit_event") {
    const info = (e as { rate_limit_info?: Record<string, unknown> }).rate_limit_info ?? {};
    const status = String(info.status ?? "unknown");
    const raw = (info.unifiedWindows ?? {}) as Record<string, { utilization?: number }>;
    const windows: Record<string, number> = {};
    for (const [name, w] of Object.entries(raw)) windows[name] = w?.utilization ?? 0;
    const quota: CliQuota = {
      status, windows,
      ...(typeof info.resetsAt === "number" ? { resetsAt: info.resetsAt } : {}),
    };
    // "allowed" is the successful case and by far the common one; only a refusal is a rate limit.
    return status === "allowed"
      ? { quota }
      : { quota, rateLimited: `${status} — ${describeWindows(windows)}` };
  }
  if (type === "assistant") {
    const msg = (e as { message?: { content?: unknown[]; model?: string } }).message;
    const parts = Array.isArray(msg?.content) ? msg.content : [];
    const text = parts
      .filter((b): b is { type: string; text: string } =>
        typeof b === "object" && b !== null && (b as { type?: string }).type === "text")
      .map((b) => b.text).join("");
    const tool = parts.find((b): b is { type: string; name: string; input?: Record<string, unknown> } =>
      typeof b === "object" && b !== null && (b as { type?: string }).type === "tool_use");
    return {
      ...(text ? { text } : {}),
      ...(msg?.model ? { served: msg.model } : {}),
      ...(tool ? { tool: { name: tool.name, ...(targetOf(tool.input) ? { target: targetOf(tool.input) } : {}) } } : {}),
    };
  }
  /**
   * The OUTCOME of a tool the CLI ran, which arrives as a user turn carrying `tool_result`.
   *
   * `tool_use` is the model asking; this is what happened. Only failures are reported — a successful call
   * was already announced when it was requested, and saying it twice would double every row.
   */
  if (type === "user") {
    const parts = (e as { message?: { content?: unknown[] } }).message?.content;
    const failed = (Array.isArray(parts) ? parts : []).find(
      (b): b is { type: string; is_error?: boolean; content?: unknown } =>
        typeof b === "object" && b !== null && (b as { type?: string }).type === "tool_result"
        && (b as { is_error?: boolean }).is_error === true);
    return failed ? { tool: { name: "tool", ok: false } } : undefined;
  }
  if (type === "result") {
    const u = (e as { usage?: Record<string, number> }).usage ?? {};
    const cost = (e as { total_cost_usd?: number }).total_cost_usd;
    return {
      usage: {
        freshTokens: u.input_tokens ?? 0,
        cachedTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        ...(cost !== undefined ? { costUsd: cost } : {}),
      },
      ...((e as { subtype?: string }).subtype === "error_during_execution"
        ? { error: String((e as { result?: unknown }).result ?? "the CLI reported an error") } : {}),
    };
  }
  return undefined;
}

/**
 * Codex's `exec --json`, decoded into the same vocabulary.
 *
 * Captured from the real binary, because two guesses about this shape were wrong. The message text is nested
 * under `item`, not at the top level — reading `e.text` returns nothing and every Codex turn comes back
 * silent. And Codex DOES report cache writes, in `cache_write_input_tokens`; an earlier comment here said it
 * did not, which would have made every Codex run look free next to a Claude one.
 *
 *   {"type":"thread.started","thread_id":"…"}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}
 *   {"type":"turn.completed","usage":{"input_tokens":15448,"cached_input_tokens":11136,
 *                                     "cache_write_input_tokens":0,"output_tokens":5}}
 */
export function decodeCodexEvent(line: string): CliEvent | undefined {
  let e: Record<string, unknown>;
  try { e = JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
  const type = String(e.type ?? "");
  if (/rate.?limit/i.test(type)) return { rateLimited: String(e.message ?? "rate limited by the CLI") };
  if (type === "item.completed") {
    const item = (e as { item?: { type?: string; text?: string; name?: string } }).item;
    if (item?.type === "agent_message" && item.text) return { text: item.text };
    // Anything else it completed is a step it took — reported for the activity strip, not executed here.
    if (item?.type && item.type !== "agent_message") {
      return { tool: { name: item.name ?? item.type } };
    }
    return undefined;
  }
  if (type === "turn.completed") {
    const u = (e as { usage?: Record<string, number> }).usage ?? {};
    return {
      usage: {
        freshTokens: u.input_tokens ?? 0,
        cachedTokens: u.cached_input_tokens ?? 0,
        cacheWriteTokens: u.cache_write_input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
      },
    };
  }
  if (type === "turn.failed" || type === "error") {
    return { error: String((e as { message?: unknown }).message ?? "codex reported an error") };
  }
  return undefined;
}

/** "five_hour 98%, seven_day 41%" — the shape a person can act on. */
function describeWindows(windows: Record<string, number>): string {
  const parts = Object.entries(windows).map(([k, v]) => `${k} ${Math.round(v * 100)}%`);
  return parts.length ? parts.join(", ") : "no window reported";
}

/**
 * What the CLI reports as the model when it did not call one.
 *
 * Claude Code does not validate `--model`. Measured: `--model definitely-not-a-model` exits 0 with
 * `subtype: "success"` and a plausible-looking answer — and `message.model` reads `<synthetic>`, meaning no
 * model ran and the text was produced locally. Nothing else in the stream says so.
 *
 * Unchecked, a typo in one chain link becomes an invented answer that horse-code records as that model's
 * work: the fitness store learns from it, the review counts it, and a role is judged on a turn that never
 * happened. It is treated as a model failure so the chain slides and the bench takes the bad name out.
 */
export const SYNTHETIC = "<synthetic>";

/** The file a tool call is about, when its input names one — for the activity strip. */
function targetOf(input: Record<string, unknown> | undefined): string | undefined {
  for (const k of ["file_path", "path", "filePath", "notebook_path"]) {
    const v = input?.[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

/**
 * Runs one headless agent turn and resolves when the CLI exits.
 *
 * Never throws for a failing CLI: a non-zero exit is a result like any other, because the caller's job is to
 * decide whether the task failed or the fleet did — the same distinction the API path draws.
 */
/**
 * Folds a chunked byte stream into events, holding the half-line between reads.
 *
 * Separated from the process plumbing because this is where the only real logic lives: the stream arrives in
 * chunks that do not respect line boundaries, so a JSON event routinely spans two reads. Forgetting the
 * remainder drops whichever event straddled the split — and for the `result` line that is the entire usage
 * accounting for the run.
 */
export function makeStreamReader(
  decode: (line: string) => CliEvent | undefined,
  onEvent: (ev: CliEvent) => void,
): { push(chunk: string): void; end(): void } {
  let pending = "";
  const drain = (upToNewline: boolean): void => {
    const lines = pending.split("\n");
    pending = upToNewline ? lines.pop() ?? "" : "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const ev = decode(line);
      if (ev) onEvent(ev);
    }
  };
  return {
    push(chunk: string) { pending += chunk; drain(true); },
    end() { if (pending.trim()) drain(false); },
  };
}

export async function runCliAgent(run: CliRun): Promise<CliResult> {
  const decode = run.kind === "claude" ? decodeClaudeEvent : decodeCodexEvent;
  const args = cliArgs(run.kind, run.prompt, run.args ?? []);
  return new Promise<CliResult>((resolve) => {
    let child;
    try {
      /**
       * stdin is CLOSED, not merely unused.
       *
       * Codex reads extra instructions from stdin when it is piped — "Reading additional input from
       * stdin…" — and a pipe nobody writes to never ends, so the process waits for input that is not
       * coming. Measured: a four-minute timeout on a call that should take seconds. `ignore` gives the
       * child no stdin at all, which is the honest description of a headless run.
       */
      child = spawn(run.kind, args, {
        cwd: run.cwd, signal: run.signal, stdio: ["ignore", "pipe", "pipe"],
        ...(run.configDir ? { env: { ...process.env, CLAUDE_CONFIG_DIR: run.configDir } } : {}),
      });
    } catch (e) {
      resolve({ text: "", error: e instanceof Error ? e.message : String(e), exitCode: -1 });
      return;
    }
    let text = "";
    let usage: CliUsage | undefined;
    let rateLimited: string | undefined;
    let served: string | undefined;
    let quota: CliQuota | undefined;
    let error: string | undefined;
    let stderr = "";
    const reader = makeStreamReader(decode, (ev) => {
      if (ev.text) text += ev.text;
      if (ev.usage) usage = ev.usage;
      if (ev.rateLimited) rateLimited = ev.rateLimited;
      if (ev.served) served = ev.served;
      if (ev.quota) quota = ev.quota;
      if (ev.error) error = ev.error;
      run.onEvent?.(ev);
    });
    child.stdout?.on("data", (d) => reader.push(d.toString()));
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => resolve({ text, ...(usage ? { usage } : {}), error: e.message, exitCode: -1 }));
    child.on("close", (code) => {
      reader.end();
      resolve({
        text,
        ...(usage ? { usage } : {}),
        ...(rateLimited ? { rateLimited } : {}),
        ...(quota ? { quota } : {}),
        ...(served ? { served } : {}),
        // stderr only becomes the error when nothing better was said — a CLI that warns on stderr and
        // succeeds must not be read as having failed.
        ...(error ?? (code !== 0 && stderr.trim()) ? { error: error ?? stderr.trim().slice(0, 500) } : {}),
        exitCode: code ?? -1,
      });
    });
  });
}
