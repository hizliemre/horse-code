import type { z } from "zod";

// --- Mesajlar ---
export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // ham JSON string (LLM'den geldiği gibi)
}

export interface Message {
  role: Role;
  content: string;
  toolCalls?: ToolCall[]; // assistant mesajlarında
  toolCallId?: string; // role === "tool" olan mesajlarda
  name?: string; // tool adı (role === "tool")
}

// --- Tool'lar ---
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

export interface Tool {
  name: string;
  description: string;
  permissionLevel: PermissionLevel;
  parameters: z.ZodType;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
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

// --- Agent event stream (UI bunlara abone olur) ---
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

// --- Tip guard'lar ---
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
