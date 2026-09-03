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
  /** A tool the CLI's own agent ran. Reported for the activity strip; horse-code does not execute it. */
  tool?: { name: string; target?: string };
  /** Terminal usage for the whole run. */
  usage?: CliUsage;
  /** The CLI said it is rate-limited. Mapped onto the same bench the API path uses. */
  rateLimited?: string;
  /** A failure the CLI reported, verbatim. */
  error?: string;
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
  onEvent?: (ev: CliEvent) => void;
}

export interface CliResult {
  text: string;
  usage?: CliUsage;
  rateLimited?: string;
  error?: string;
  exitCode: number;
}

/** The argv for a headless run, per CLI. Kept in one place so the two shapes can be read side by side. */
export function cliArgs(kind: CliKind, prompt: string, extra: string[] = []): string[] {
  return kind === "claude"
    // `--verbose` is required for stream-json to emit the per-turn events rather than only the result.
    ? ["-p", prompt, "--output-format", "stream-json", "--verbose", ...extra]
    : ["exec", "--json", prompt, ...extra];
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
    return { rateLimited: String((e as { message?: unknown }).message ?? "rate limited by the CLI") };
  }
  if (type === "assistant") {
    const msg = (e as { message?: { content?: unknown[] } }).message;
    const parts = Array.isArray(msg?.content) ? msg.content : [];
    const text = parts
      .filter((b): b is { type: string; text: string } =>
        typeof b === "object" && b !== null && (b as { type?: string }).type === "text")
      .map((b) => b.text).join("");
    const tool = parts.find((b): b is { type: string; name: string; input?: Record<string, unknown> } =>
      typeof b === "object" && b !== null && (b as { type?: string }).type === "tool_use");
    return {
      ...(text ? { text } : {}),
      ...(tool ? { tool: { name: tool.name, ...(targetOf(tool.input) ? { target: targetOf(tool.input) } : {}) } } : {}),
    };
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

/** Codex's `exec --json`, decoded into the same vocabulary. */
export function decodeCodexEvent(line: string): CliEvent | undefined {
  let e: Record<string, unknown>;
  try { e = JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
  const type = String(e.type ?? "");
  if (/rate.?limit/i.test(type)) return { rateLimited: String(e.message ?? "rate limited by the CLI") };
  if (type === "item.completed" || type === "message") {
    const text = String((e as { text?: unknown }).text ?? (e as { message?: unknown }).message ?? "");
    return text ? { text } : undefined;
  }
  if (type === "turn.completed" || type === "usage") {
    const u = (e as { usage?: Record<string, number> }).usage ?? {};
    return {
      usage: {
        freshTokens: u.input_tokens ?? 0,
        cachedTokens: u.cached_input_tokens ?? 0,
        cacheWriteTokens: 0,   // Codex does not report a write figure; absent is honest, zero is not a claim
        outputTokens: u.output_tokens ?? 0,
      },
    };
  }
  return undefined;
}

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
      child = spawn(run.kind, args, { cwd: run.cwd, signal: run.signal });
    } catch (e) {
      resolve({ text: "", error: e instanceof Error ? e.message : String(e), exitCode: -1 });
      return;
    }
    let text = "";
    let usage: CliUsage | undefined;
    let rateLimited: string | undefined;
    let error: string | undefined;
    let stderr = "";
    const reader = makeStreamReader(decode, (ev) => {
      if (ev.text) text += ev.text;
      if (ev.usage) usage = ev.usage;
      if (ev.rateLimited) rateLimited = ev.rateLimited;
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
        // stderr only becomes the error when nothing better was said — a CLI that warns on stderr and
        // succeeds must not be read as having failed.
        ...(error ?? (code !== 0 && stderr.trim()) ? { error: error ?? stderr.trim().slice(0, 500) } : {}),
        exitCode: code ?? -1,
      });
    });
  });
}
