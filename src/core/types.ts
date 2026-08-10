import type { z } from "zod";

// --- Messages ---
export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // raw JSON string (as it comes from the LLM)
}

export interface Message {
  role: Role;
  content: string;
  toolCalls?: ToolCall[]; // on assistant messages
  toolCallId?: string; // on messages where role === "tool"
  name?: string; // tool name (role === "tool")
  images?: string[]; // user messages: base64 data URIs (data:image/png;base64,…) → sent as image parts
  /**
   * The call's own identity (`path:… |limit=…`), on tool results — never sent to the model.
   *
   * Carried so that putting a result away can also retract the recall memo's claim to still have it. Without
   * it the two mechanisms contradict each other: compaction says "call it again if you still need what it
   * said" and `Recall` refuses the call with "its result is above", pointing at the stub that replaced it.
   */
  key?: string;
}

// --- Tools ---
export type PermissionLevel = "safe" | "write" | "exec";
export type PermissionMode = "ask" | "acceptEdits" | "auto";

export interface ToolResult {
  content: string;
  isError: boolean;
}

/** A file-touching tool's activity, surfaced in the chat flow (Claude Code-style: name + target + preview). */
export interface ToolActivity {
  /**
   * Which agent made the call, when one did.
   *
   * Without it every tool line from every parallel implementer landed in one undifferentiated chat flow —
   * five agents interleaved, and no way to tell whose call was whose. Attributed activity belongs to that
   * agent's row instead of to the conversation.
   */
  agent?: string;
  tool: string;      // "write" | "edit" | any tool name
  target: string;    // the file path (relative to cwd), or a short description of what the call asked for
  lines: number;     // lines written / changed; 0 for a tool that does not touch a file
  /**
   * One-line outcome for a tool that produced no file diff — a lookup, a search, a command.
   *
   * Its presence is what distinguishes the two renderings: with a `summary` the activity is a single chat
   * line, without one it is a header plus a content preview. Every executed tool lands in the chat either
   * way. They used to appear only in a transient line UNDER the progress indicator and then vanish, which
   * lost the record of what an agent actually did and made the indicator itself jump as the line came and
   * went.
   */
  summary?: string;
  /** False when the call failed — rendered so a failing tool is not mistaken for a successful one. */
  ok?: boolean;
  /**
   * How many consecutive calls this row stands for, and to what.
   *
   * A planning agent reads the same spec twenty times at different offsets. Twenty rows saying
   * `read_file(spec.md) · ---` bury the two rows that matter — the failures, and the files it never found.
   * A run of calls to the same tool becomes one row.
   */
  runs?: { target: string; count: number }[];
  /**
   * How many of those calls FAILED, and whether the run is over.
   *
   * A run used to be broken by any failure so the failed call could have its own row. That was right about
   * what matters and wrong about what it cost: eight calls became eight rows, and the model's answer — the
   * thing being read — was pushed off the screen by the work that produced it. The failure is kept as a
   * COUNT on the folded row instead, which says the same thing in one line.
   *
   * `settled` is false while the run is still going: the row then reads "Running N …" and shows the call in
   * flight. Once anything else is said, it becomes "Ran N …" and the detail goes away.
   */
  failed?: number;
  settled?: boolean;
  /**
   * Which tools the run was made of, and how many of each.
   *
   * A run used to be broken whenever the tool changed, so a lone `grep` between two runs of reads got its
   * own row — with its regex and a slice of its output. Measured on one turn: four folded rows and two bare
   * greps, for eleven calls that said one thing between them. What matters is that the agent was looking,
   * how much, and whether anything failed; WHICH tool is a detail that fits on the same line.
   */
  tools?: { tool: string; count: number }[];
  preview?: string[]; // first lines of the written / changed content (shown under the header; for an edit, the ADDED lines)
  startLine?: number; // 1-based line number the preview begins at (write → 1; edit → where the change starts)
  removed?: string[]; // edit only: the REPLACED (old) lines → rendered as a - / + diff against `preview`
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  onActivity?: (a: ToolActivity) => void; // optional live-activity sink (file writes/edits)
  remember?: (fact: string) => void; // persist a durable fact learned from a tool result (remember_fact tool)
  /**
   * Absolute paths this agent has READ during this run. `write_file` refuses to overwrite an existing file
   * that is not in here: an agent that has not looked at a file cannot know what it is destroying.
   */
  readFiles?: Set<string>;
  // Queue a memory PROPOSAL (propose_memory tool). Returns whether it was queued. Writes nothing: review
  // agents propose, and a single trusted curator decides what is actually stored.
  proposeMemory?: (text: string, kind: "fact" | "lesson") => boolean;
  /**
   * What the agent SAID in the same turn as this call — the prose the user can actually read above it.
   *
   * `ask_user` needs it to tell a resolvable reference from a dangling one: "the 5 items above" is fine
   * after a message that listed five items, and points at nothing after a turn that only called tools.
   */
  said?: string;
}

export interface PermissionDescriptor {
  allowKey: string; // shell: command · file: target path
  preview: string; // summary to show the user (command, diff title, etc.)
}

export interface Tool {
  name: string;
  description: string;
  permissionLevel: PermissionLevel;
  parameters: z.ZodType;
  // An already-formed JSON Schema (draft-7) → sent to the model verbatim instead of deriving it from
  // `parameters`. Used by MCP tools, whose input schema arrives as JSON Schema, not zod.
  rawSchema?: unknown;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  // write/exec tools produce a permission request; not needed for safe tools.
  describe?(args: Record<string, unknown>): PermissionDescriptor;
}

// --- Provider (LLM gateway) ---
export interface ChatRequest {
  model: string;
  messages: Message[];
  tools: { name: string; description: string; parameters: unknown }[];
}

export type ChatEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; toolCall: ToolCall }
  // Live progress while the model is STILL generating a tool call's arguments (e.g. a large write_file body),
  // so the UI can show "writing <path> · N chars" instead of a silent multi-minute wait.
  | { type: "tool-progress"; name: string; chars: number; path?: string }
  | { type: "usage"; promptTokens: number; completionTokens: number; cachedTokens?: number }
  | { type: "done"; finishReason: "stop" | "tool_calls" | "length" }
  /**
   * `retryable` = a fallback model may succeed with the same request.
   * `capability` = the model REFUSED THIS REQUEST for what it is (too much context, an unsupported feature),
   *   not because it is unwell. Both fall back, but only the first means the model is spent: benching a model
   *   over a request that was merely too large makes it unavailable for every smaller request afterwards.
   */
  /**
   * `capability` — this model/subscription refused the request; another may accept it.
   * `noBench` — the failure says nothing about the model's HEALTH (a bad model id, a configuration fault).
   *   Falling to the next model is still right; taking this one out of service is not.
   */
  | { type: "error"; message: string; retryable?: boolean; capability?: boolean; noBench?: boolean };

export interface Provider {
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
}

// --- Agent event stream (the UI subscribes to these) ---
export type AgentEvent =
  | { type: "message.delta"; text: string }
  | { type: "message.done"; message: Message }
  | { type: "tool.request"; toolCall: ToolCall }
  | { type: "tool.result"; toolCallId: string; result: ToolResult }
  | {
      type: "permission.ask";
      requestId: string;
      toolName: string;
      permissionLevel: PermissionLevel;
      preview: string;
    }
  | { type: "usage"; promptTokens: number; completionTokens: number; cachedTokens?: number }
  | { type: "error"; message: string; retryable?: boolean }
  | { type: "abort" };

// --- Type guards ---
export function isTextDelta(
  e: ChatEvent,
): e is Extract<ChatEvent, { type: "text-delta" }> {
  return e.type === "text-delta";
}

export function isToolCallEvent(
  e: ChatEvent,
): e is Extract<ChatEvent, { type: "tool-call" }> {
  return e.type === "tool-call";
}
