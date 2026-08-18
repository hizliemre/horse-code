import type { AgentEvent, PermissionDescriptor, Tool, ToolCall, ToolResult } from "../core/types.js";
import { truncateSafe } from "../core/surrogates.js";
import type { PermissionEngine, PermissionRequest } from "../permission/engine.js";
import type { ToolRegistry } from "../tools/registry.js";
import { Recall, recallNote, refusalNote } from "./recall.js";
import { telemetry } from "../obs/telemetry.js";
import { subjectOfArgs, relativise } from "./elide.js";

export interface ToolExecResult {
  id: string;
  name: string;
  result: ToolResult;
  /** The call's identity, carried onto the tool message so compaction can retract the recall memo's claim. */
  key?: string;
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
  recall?: Recall; // what this agent has already been shown → an identical call is answered with a pointer
  said?: string; // the prose of the turn these calls came with → `ask_user` checks its references against it
  role?: string; // who is calling → recorded on tool events so a repeat can be attributed to an agent
  /**
   * …and WHICH agent, since a role is run many times over.
   *
   * One id per memo. Without it, four reads of one path under the role `planner` cannot be told apart as one
   * agent repeating itself — waste the memo should have caught — from four agents each asking once, which is
   * correct. Two separate diagnoses stopped at exactly that question.
   */
  agentId?: string;
  model?: string; // …and what is serving it → shown beside the role when a tool stops to ask the user
}

/** The call's identity, or nothing — see ToolExecResult.key. */
function keyOf(args?: Record<string, unknown>): { key?: string } {
  const key = subjectOfArgs(args ?? {});
  return key ? { key } : {};
}

const WRITE_TOOLS = new Set(["write_file", "edit_file"]); // tools whose success should trigger a per-file commit

/** How much of a failure is written to telemetry. Long enough to name the cause, short enough to stay a log. */
export const MAX_ERROR_EXCERPT = 300;

/**
 * What went wrong, in the record — because `hc.result_chars: 464` is not a diagnosis.
 *
 * Taken from the END, not the beginning. A shell result opens with `$ <command>`, so cutting from the front
 * spent the whole budget echoing the command back: measured on a live run, a failed inline python heredoc
 * recorded 300 characters of its own source and not one word of why it failed — while the command itself was
 * already in `hc.tool.key`, twice over. A tool says what went wrong last.
 *
 * Telemetry recorded that a tool call failed and how many characters it said, and nothing about what it said.
 * Watching a live run, that is the difference between reading the answer and re-running the command by hand
 * to find it: measured on one run, two shell failures took a manual re-run each to establish that one was
 * prettier reporting an unformatted file (exit 1, working correctly) and the other a plugin that would not
 * resolve from the given directory. Two entirely different situations, identical in the log.
 *
 * Errors only. A successful result is the file, the search hits, the diff — recording those would put the
 * user's source into a log file that exists to describe the run, not to copy it. A failure is a sentence.
 */
export function errorExcerpt(content: string | undefined): string {
  const said = (content ?? "").replace(/\s+/g, " ").trim();
  return said.length > MAX_ERROR_EXCERPT ? `…${said.slice(-MAX_ERROR_EXCERPT)}` : said;
}

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
    proposeMemory: deps.proposeMemory, readFiles: deps.readFiles, said: deps.said,
    ...(deps.role ? { role: deps.role } : {}), ...(deps.model ? { model: deps.model } : {}),
  });
  // Every tool call, with what it was asked and what came back — the record that made "496 calls in two
  // minutes, the same three files" visible in the first place, now available without reading a screenshot.
  const tel = telemetry();
  /**
   * `subject` is what the chat line shows — the path, kept short. `key` is the call's full identity,
   * including the range, because a monitor that counts pages of one file as re-reads of it reports a loop
   * that is not there. Found by using the monitor: it showed 16 re-reads that were 16 different pages.
   */
  // …and spelled one way, so the memo and the telemetry both see one file. See relativise.
  const key = relativise(subjectOfArgs(args), deps.cwd);
  /**
   * An answer the agent already has is not fetched twice.
   *
   * Measured over one run: 1,141 of an agent's 6,743 reads and searches were identical to one it had already
   * made in the same conversation — the result still sitting in its own context. Each cost a full model turn.
   */
  const earlier = deps.recall?.recall(tool.name, key);
  if (earlier !== undefined) {
    tel.event("tool.recalled", { "hc.tool": tool.name, "hc.tool.subject": subject, "hc.tool.key": key,
      "hc.recall.authored": earlier.authored, ...(earlier.settled ? { "hc.recall.settled": true } : {}),
      ...(deps.role ? { "hc.role": deps.role } : {}),
      ...(deps.agentId ? { "hc.agent": deps.agentId } : {}) });
    deps.onActivity?.({ tool: tool.name, target: subject, lines: 0,
      summary: earlier.settled ? `refused on turn ${earlier.turn} — unchanged`
        : earlier.authored ? "you wrote this — it is above" : `already answered on turn ${earlier.turn}` });
    /**
     * A refusal comes back as a refusal.
     *
     * Answering it with `isError: false` would tell the agent its call had succeeded, and the second time
     * round it would be the one call in the transcript that looked like it worked.
     */
    if (earlier.settled) {
      return { content: refusalNote(tool.name, subject, earlier.turn), isError: true, settled: true };
    }
    return { content: recallNote(tool.name, subject, earlier.turn, earlier.authored), isError: false };
  }
  const result = await tel.span(`tool.${tool.name}`,
    { "hc.tool": tool.name, "hc.tool.subject": subject, "hc.tool.key": key }, run);
  if (!result.isError) deps.recall?.note(tool.name, key);
  else if (result.settled) deps.recall?.settle(tool.name, key);
  tel.event("tool.result", {
    "hc.tool": tool.name,
    "hc.tool.subject": subject,
    "hc.tool.key": key,
    "hc.result_chars": (result.content ?? "").length,
    "hc.status": result.isError ? "error" : "ok",
    ...(deps.role ? { "hc.role": deps.role } : {}),
    ...(deps.agentId ? { "hc.agent": deps.agentId } : {}),
    ...(result.isError ? { "hc.error": errorExcerpt(result.content) } : {}),
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
/** Punctuation removed: the only thing that differs when a model rewrites `mcp__a-b__c` as `mcp_a_b_c`. */
const shapeOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The one tool whose name differs from `called` only in punctuation, or undefined when it is not unique. */
export function resolveByShape(called: string, available: string[]): string | undefined {
  const want = shapeOf(called);
  const hits = available.filter((n) => shapeOf(n) === want);
  return hits.length === 1 ? hits[0] : undefined;
}

/** Character-pair overlap (Dice). Cheap, and unlike a prefix it sees a difference at the FRONT of a word. */
function similarity(a: string, b: string): number {
  const pairs = (s: string): string[] => Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2));
  const A = pairs(a), B = pairs(b);
  if (!A.length || !B.length) return a === b ? 1 : 0;
  const pool = [...B];
  let hit = 0;
  for (const p of A) { const at = pool.indexOf(p); if (at >= 0) { pool.splice(at, 1); hit++; } }
  return (2 * hit) / (A.length + B.length);
}

/**
 * What to say when a call's arguments do not parse.
 *
 * They reach here in one shape: the stream carrying them stopped part-way. The transport turns that into a
 * retry while nothing has streamed yet (see src/providers/omniroute.ts); this is the remainder, where the
 * model had already written prose and the turn cannot be re-run.
 *
 * "arguments are invalid JSON" said nothing about whether the call had run, and gave no reason to do
 * anything differently the second time. Measured live: 155 seconds of a `write_file` lost this way.
 *
 * The tool's own name is not repeated here — errResult puts it in front of every message it delivers.
 */
export function brokenArguments(args: string | undefined): string {
  const chars = args?.length ?? 0;
  return `the arguments did not arrive complete — ${chars} characters that are not whole JSON. `
    + "Nothing ran and nothing was written. Call it again; if the content is long, write it in several "
    + "smaller calls rather than one.";
}

export function unknownTool(name: string, available: string[]): string {
  /**
   * Ranked by shape, not by prefix.
   *
   * The first version compared leading characters, which is right for a truncated name and useless for the
   * mistake that actually recurs: a model reaching for `read_file` and writing `view_file`. Measured live —
   * four attempts at `view_file` in one run, and the suggester offered nothing for it, nor for `open_file`,
   * `list_files` or `cat`. The differing letters are at the FRONT, which is exactly where a prefix match
   * looks and finds nothing.
   *
   * Several names are offered rather than one. `view_file` sits equally close to `read_file` and
   * `edit_file`, and picking one of them by a hair would be a guess dressed as an answer.
   */
  const scored = available
    .map((n) => ({ n, s: similarity(shapeOf(name), shapeOf(n)) }))
    .filter((x) => x.s >= 0.4)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
  const close = scored.length
    ? ` Did you mean ${scored.map((x) => `\`${x.n}\``).join(" or ")}?`
    : "";
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
    const names = deps.tools.list().map((t) => t.name);
    /**
     * A name that differs only in punctuation is the same name.
     *
     * MCP tools are registered as `mcp__<server>__<tool>`, and a server name may contain a hyphen —
     * `mcp__angular-cli__list_projects`. Models rewrite that as `mcp_angular_cli_list_projects` with
     * dependable regularity: measured twice in one run, and in an earlier run it cost seven turns and the
     * phase's whole output. There is nothing to disambiguate: strip the punctuation from both and they are
     * the same string, so the call is resolved rather than refused.
     *
     * Only when the match is UNIQUE. Two tools that normalise alike is a genuine ambiguity, and guessing
     * between them would be the mistake this is meant to prevent.
     */
    const tool = deps.tools.get(call.name) ?? (() => {
      const resolved = resolveByShape(call.name, names);
      return resolved ? deps.tools.get(resolved) : undefined;
    })();
    if (!tool) {
      plans.push({ index: i, call, kind: "error", errorContent: unknownTool(call.name, names) });
      continue;
    }
    if (tool.name !== call.name) {
      telemetry().event("tool.renamed", { "hc.tool": tool.name, "hc.called": call.name });
    }
    let args: Record<string, unknown>;
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      plans.push({ index: i, call, kind: "error", errorContent: brokenArguments(call.arguments) });
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
        // Attributed like every other result. A call that never ran is the one most worth attributing:
        // a role inventing a tool name is exactly what a reader of the log is trying to pin down.
        ...(deps.role ? { "hc.role": deps.role } : {}),
        ...(deps.agentId ? { "hc.agent": deps.agentId } : {}),
      });
      yield { type: "tool.request", toolCall: p.call };
      // Omitted when empty: a key that identifies nothing cannot be forgotten by, and an absent field
      // keeps the result exactly the shape it was.
      results[p.index] = { id: p.call.id, name: p.call.name, result, ...keyOf(p.args) };
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
    results[p.index] = { id: p.call.id, name: p.call.name, result: autoResults[k], ...keyOf(p.args) };
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
    // Omitted when empty: a key that identifies nothing cannot be forgotten by, and an absent field
      // keeps the result exactly the shape it was.
      results[p.index] = { id: p.call.id, name: p.call.name, result, ...keyOf(p.args) };
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

/**
 * The ceiling under every tool result, whoever wrote the tool.
 *
 * Each tool bounds its own output and each bound was a COUNT rather than a size — `grep` capped matches, and
 * a match is a line with no length limit. Measured on a real project: one line of `graphify-out/graph.json`
 * is 35,272,070 characters, and a live run's brainstormer reached a 3,397,616-character prompt in a single
 * call, after which nothing it did could work.
 *
 * That hole is closed where it was made. This is the floor under all of them, including tools added later
 * and MCP servers nobody here wrote: whatever comes back, it cannot become the conversation.
 *
 * The BEGINNING is kept. A result is written most-important-first — the matches, the listing, the error —
 * and a reader who needs more can ask a narrower question.
 */
export const MAX_TOOL_RESULT_CHARS = 120_000;

export function capToolResult(content: string, tool: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  // truncateSafe, not slice: cutting by code unit splits an emoji in half and the request is refused.
  return `${truncateSafe(content, MAX_TOOL_RESULT_CHARS)}\n\n`
    + `… [${tool} returned ${content.length} characters; truncated at ${MAX_TOOL_RESULT_CHARS}. `
    + `Ask a narrower question — a smaller path, a tighter pattern, a specific file.]`;
}
