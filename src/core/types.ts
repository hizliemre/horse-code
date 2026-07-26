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
  tool: string;      // "write" | "edit"
  target: string;    // the file path (relative to cwd)
  lines: number;     // lines written / changed
  preview?: string[]; // first lines of the written / changed content (shown under the header; for an edit, the ADDED lines)
  startLine?: number; // 1-based line number the preview begins at (write → 1; edit → where the change starts)
  removed?: string[]; // edit only: the REPLACED (old) lines → rendered as a - / + diff against `preview`
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  onActivity?: (a: ToolActivity) => void; // optional live-activity sink (file writes/edits)
  remember?: (fact: string) => void; // persist a durable fact learned from a tool result (remember_fact tool)
  // Queue a memory PROPOSAL (propose_memory tool). Returns whether it was queued. Writes nothing: review
  // agents propose, and a single trusted curator decides what is actually stored.
  proposeMemory?: (text: string, kind: "fact" | "lesson") => boolean;
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
  | { type: "error"; message: string; retryable?: boolean }; // retryable = transient (429/5xx/network) → a fallback model may succeed

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
