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
}

// --- Tools ---
export type PermissionLevel = "safe" | "write" | "exec";
export type PermissionMode = "ask" | "acceptEdits" | "auto";

export interface ToolResult {
  content: string;
  isError: boolean;
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
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
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "done"; finishReason: "stop" | "tool_calls" | "length" }
  | { type: "error"; message: string };

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
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "error"; message: string }
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
