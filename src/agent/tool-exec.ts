import type { AgentEvent, PermissionDescriptor, Tool, ToolCall, ToolResult } from "../core/types.js";
import type { PermissionEngine, PermissionRequest } from "../permission/engine.js";
import type { ToolRegistry } from "../tools/registry.js";
import { telemetry } from "../obs/telemetry.js";
import { subjectOfArgs } from "./elide.js";

export interface ToolExecResult {
  id: string;
  name: string;
  result: ToolResult;
}

export interface ToolExecDeps {
  tools: ToolRegistry;
  permission: PermissionEngine;
  approve: (req: PermissionRequest) => Promise<boolean>;
  cwd: string;
  signal: AbortSignal;
  onActivity?: (a: import("../core/types.js").ToolActivity) => void; // live file-write/edit activity → UI
  remember?: (fact: string) => void; // remember_fact tool → persist a durable fact
  readFiles?: Set<string>; // files read this run → gates blind overwrites in write_file
  proposeMemory?: (text: string, kind: "fact" | "lesson") => boolean; // propose_memory tool → curator queue
  onWrite?: (path: string) => Promise<void>; // after each successful write/edit → per-file auto-commit (sequential)
}

const WRITE_TOOLS = new Set(["write_file", "edit_file"]); // tools whose success should trigger a per-file commit

interface Plan {
  index: number;
  call: ToolCall;
  kind: "run" | "ask" | "error" | "deny";
  tool?: Tool;
  args?: Record<string, unknown>;
  req?: PermissionRequest;
  errorContent?: string;
}

function errResult(name: string, msg: string): ToolResult {
  return { content: `${name}: ${msg}`, isError: true };
}

/**
 * Filters and runs tool-calls through permission checks. Allows run in parallel, asks run sequentially.
 * Emits AgentEvent; returns results IN CALL ORDER (one result per call).
 */

/** The argument worth showing in the chat line — the one that says what the call was actually about. */
function callSubject(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  for (const key of ["path", "file", "file_path", "symbol", "pattern", "query", "command", "name", "url", "question"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return v.length > 60 ? `${v.slice(0, 59)}…` : v;
  }
  const first = Object.values(args).find((v) => typeof v === "string" && v.trim());
  return typeof first === "string" ? (first.length > 60 ? `${first.slice(0, 59)}…` : first) : "";
}

/**
 * A one-line account of what came back, for a tool that produced no file diff.
 *
 * A shell result opens with `$ <command>` so the MODEL's transcript records what ran. The chat line already
 * names the command — it is the `target` — so taking that first line put the same command on the line twice,
 * once bold and once dim, and pushed out the only new thing there was: what the command actually said. On a
 * run making hundreds of calls that doubling is most of the noise.
 */
export function outcome(result: import("../core/types.js").ToolResult, subject = ""): string {
  const lines = (result.content ?? "").split("\n").map((l) => l.trim());
  const head = subject.replace(/…$/, "").slice(0, 24);
  const line = lines.find((l) => l && !(l.startsWith("$ ") && head.length > 0 && l.slice(2).startsWith(head))) ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/**
 * Runs one tool and makes sure it leaves a record in the chat.
 *
 * `write_file`/`edit_file` report themselves, with a diff. Everything else — reads, searches, shell, graph
 * lookups — reported nothing, so it surfaced only in the transient line under the progress indicator and then
 * vanished: the record of what an agent did was lost, and the indicator visibly jumped as that line came and
 * went. Anything that did not report itself gets a compact line here instead.
 */
async function runTool(
  tool: { name: string; run: (args: Record<string, unknown>, ctx: import("../core/types.js").ToolContext) => Promise<import("../core/types.js").ToolResult> },
  args: Record<string, unknown>,
  deps: ToolExecDeps,
): Promise<import("../core/types.js").ToolResult> {
  let reported = false;
  const onActivity = deps.onActivity
    ? (a: import("../core/types.js").ToolActivity): void => { reported = true; deps.onActivity?.(a); }
    : undefined;
  const subject = callSubject(args);
  const run = (): Promise<import("../core/types.js").ToolResult> => tool.run(args, {
    cwd: deps.cwd, signal: deps.signal, onActivity, remember: deps.remember,
    proposeMemory: deps.proposeMemory, readFiles: deps.readFiles,
  });
  // Every tool call, with what it was asked and what came back — the record that made "496 calls in two
  // minutes, the same three files" visible in the first place, now available without reading a screenshot.
  const tel = telemetry();
  /**
   * `subject` is what the chat line shows — the path, kept short. `key` is the call's full identity,
   * including the range, because a monitor that counts pages of one file as re-reads of it reports a loop
   * that is not there. Found by using the monitor: it showed 16 re-reads that were 16 different pages.
   */
  const key = subjectOfArgs(args);
  const result = await tel.span(`tool.${tool.name}`,
    { "hc.tool": tool.name, "hc.tool.subject": subject, "hc.tool.key": key }, run);
  tel.event("tool.result", {
    "hc.tool": tool.name,
    "hc.tool.subject": subject,
    "hc.tool.key": key,
    "hc.result_chars": (result.content ?? "").length,
    "hc.status": result.isError ? "error" : "ok",
  });
  if (!reported) {
    const target = subject;
    deps.onActivity?.({
      tool: tool.name, target, lines: 0,
      /**
       * A successful read says nothing worth a second column.
       *
       * Its summary was the first line of whatever happened to be at that offset — `import { defineConfig }`,
       * `<!--`, a stray brace — which tells you nothing about the read and pushes the file's own name toward
       * the edge. A FAILED read is the opposite ("offset 560 is past the end of a 473-line file"): that is
       * the whole reason the line is there.
       */
      summary: tool.name === "read_file" && !result.isError ? "" : outcome(result, target),
      ok: !result.isError,
    });
  }
  return result;
}

/**
 * What to say when a tool does not exist.
 *
 * The whole message used to be `unknown tool: <name>`, which tells the model nothing it can act on — so it
 * guesses. Observed on a real run: a project-manager invented an MCP tool that was never registered for it
 * and spent SEVEN turns extending the name one fragment at a time
 * (`…list_projects_ide`, `…_9564507f_ide`, `…_9564507f2f_ide`, …) before the phase died without writing its
 * file. A hundred and thirty-three minutes and eighteen million input tokens, ended by a message that had
 * the answer and did not give it.
 *
 * The nearest name comes first — a wrong name is almost always a near miss — and the full list follows,
 * because "there is no such tool" is only useful next to "these exist".
 */
export function unknownTool(name: string, available: string[]): string {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = norm(name);
  // Longest shared prefix on the normalised names: cheap, and exactly right for a mangled or truncated one.
  const shared = (a: string): number => { let n = 0; while (n < a.length && n < target.length && a[n] === target[n]) n++; return n; };
  const ranked = [...available].sort((a, b) => shared(norm(b)) - shared(norm(a)));
  const best = ranked[0];
  const close = best && shared(norm(best)) >= 4 ? ` Did you mean \`${best}\`?` : "";
  return `unknown tool: ${name}.${close} There is no tool by that name — do not guess at variants of it. `
    + `The tools you have are: ${available.join(", ")}.`;
}

export async function* executeToolCalls(
  calls: ToolCall[],
  deps: ToolExecDeps,
): AsyncGenerator<AgentEvent, ToolExecResult[], void> {
  const results: ToolExecResult[] = new Array(calls.length);
  const plans: Plan[] = [];

  // 1) Classify
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (!call.id) {
      plans.push({ index: i, call, kind: "error", errorContent: "invalid tool-call id" });
      continue;
    }
    const tool = deps.tools.get(call.name);
    if (!tool) {
      plans.push({ index: i, call, kind: "error", errorContent: unknownTool(call.name, deps.tools.list().map((t) => t.name)) });
      continue;
    }
    let args: Record<string, unknown>;
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      plans.push({ index: i, call, kind: "error", errorContent: "arguments are invalid JSON" });
      continue;
    }
    if (tool.permissionLevel === "safe") {
      plans.push({ index: i, call, kind: "run", tool, args });
      continue;
    }
    let desc: PermissionDescriptor;
    try {
      desc = tool.describe ? tool.describe(args) : { allowKey: call.name, preview: call.name };
    } catch (e) {
      plans.push({
        index: i, call, kind: "error",
        errorContent: `describe error: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    const req: PermissionRequest = { level: tool.permissionLevel, preview: desc.preview, allowKey: desc.allowKey };
    const decision = deps.permission.check(req);
    plans.push({ index: i, call, kind: decision === "allow" ? "run" : decision === "ask" ? "ask" : "deny", tool, args, req });
  }

  // 2) error / deny → immediate result
  for (const p of plans) {
    if (p.kind === "error" || p.kind === "deny") {
      const result = p.kind === "error"
        ? errResult(p.call.name, p.errorContent!)
        : errResult(p.call.name, "user denied");
      /**
       * A call that never ran still happened.
       *
       * Only the executing path was recorded, so a call to a tool that does not exist — or one the user
       * denied — left NOTHING in the telemetry. That is the one class of failure the record most needs to
       * carry: a role guessing at a tool name looks, in the log, like a role doing nothing at all.
       *
       * Found while diagnosing a run that died after seven such turns. The log showed model calls with
       * shrinking output and no tool activity between them, which reads as "the model stopped calling
       * tools" — the opposite of what happened. Measuring the absence proved nothing, and I nearly
       * concluded the fix did not apply.
       */
      telemetry().event("tool.result", {
        "hc.tool": p.call.name,
        "hc.outcome": p.kind === "error" ? "unknown-or-invalid" : "denied",
        "hc.error": result.content.slice(0, 200),
      });
      yield { type: "tool.request", toolCall: p.call };
      results[p.index] = { id: p.call.id, name: p.call.name, result };
      yield { type: "tool.result", toolCallId: p.call.id, result };
    }
  }

  // 3) auto (allow) → parallel
  const autoPlans = plans.filter((p) => p.kind === "run");
  for (const p of autoPlans) yield { type: "tool.request", toolCall: p.call };
  const autoResults = await Promise.all(
    autoPlans.map((p) => runTool(p.tool!, p.args!, deps)),
  );
  for (let k = 0; k < autoPlans.length; k++) {
    const p = autoPlans[k];
    results[p.index] = { id: p.call.id, name: p.call.name, result: autoResults[k] };
    yield { type: "tool.result", toolCallId: p.call.id, result: autoResults[k] };
  }

  // 4) gated (ask) → sequential
  for (const p of plans.filter((pp) => pp.kind === "ask")) {
    yield { type: "tool.request", toolCall: p.call };
    // Re-check at execution time, NOT just at plan time: several tool-calls in one turn are all planned as
    // "ask" up front, then prompted one by one. If the user switches the mode to `auto` (or otherwise widens
    // permission) WHILE an earlier ask is pending, that change must apply to these still-queued asks — so a
    // mid-job "→ auto" stops nagging immediately instead of asking for everything already planned.
    const decision = deps.permission.check(p.req!);
    let ok: boolean;
    if (decision === "allow") {
      ok = true; // mode widened since planning → auto-allow, no prompt
    } else if (decision === "deny") {
      ok = false;
    } else {
      yield {
        type: "permission.ask",
        requestId: p.call.id,
        toolName: p.call.name,
        permissionLevel: p.tool!.permissionLevel,
        preview: p.req!.preview,
      };
      ok = await deps.approve(p.req!);
    }
    const result = ok
      ? await runTool(p.tool!, p.args!, deps)
      : errResult(p.call.name, "user denied");
    results[p.index] = { id: p.call.id, name: p.call.name, result };
    yield { type: "tool.result", toolCallId: p.call.id, result };
  }

  // Per-file auto-commit: after all tools ran, commit each successful write/edit — SEQUENTIALLY, since git
  // isn't parallel-safe (the auto batch above may have run several writes at once).
  if (deps.onWrite) {
    for (const p of plans) {
      if (p.kind !== "run" && p.kind !== "ask") continue;
      if (!WRITE_TOOLS.has(p.call.name)) continue;
      if (results[p.index]?.result.isError) continue; // denied / failed write → nothing to commit
      const path = typeof p.args?.path === "string" ? p.args.path : undefined;
      if (path) await deps.onWrite(path);
    }
  }

  return results;
}
