import { z } from "zod";
import type { Tool } from "../core/types.js";
import type { McpServerSpec } from "../config/config.js";
import { connectMcpServer, type McpConnection, type McpTool } from "./client.js";

/** Prefixed, API-safe tool name: mcp__<server>__<tool>. */
export function mcpToolName(server: string, tool: string): string {
  const safe = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `mcp__${safe(server)}__${safe(tool)}`;
}

/** Wraps one MCP tool as a horse-code Tool (exec-level → goes through the approval gate). */
export function mcpToolAdapter(conn: McpConnection, tool: McpTool): Tool {
  const name = mcpToolName(conn.name, tool.name);
  return {
    name,
    description: `[MCP:${conn.name}] ${tool.description ?? tool.name}`,
    permissionLevel: "exec",
    parameters: z.record(z.string(), z.unknown()), // unused — rawSchema is what the model sees
    rawSchema: tool.inputSchema, // MCP provides a JSON Schema; send it verbatim
    describe: (args) => ({ allowKey: `mcp:${conn.name}:${tool.name}`, preview: `mcp ${conn.name}/${tool.name} ${JSON.stringify(args)}`.slice(0, 200) }),
    async run(args) {
      try {
        const res = await conn.callTool(tool.name, args as Record<string, unknown>);
        return { content: res.content, isError: res.isError };
      } catch (e) {
        return { content: `${name}: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    },
  };
}

export interface McpStatus {
  name: string;
  ok: boolean;
  toolCount: number;
  error?: string;
}

export interface McpBundle {
  connections: McpConnection[];
  tools: Tool[];
  status: McpStatus[];
  closeAll(): Promise<void>;
}

/** Connects to every configured MCP server (parallel, failures tolerated) → adapted tools + status. */
export async function connectAllMcp(specs: Record<string, McpServerSpec>): Promise<McpBundle> {
  const entries = Object.entries(specs);
  const results = await Promise.all(
    entries.map(async ([name, spec]): Promise<{ conn?: McpConnection; status: McpStatus }> => {
      try {
        const conn = await connectMcpServer(name, spec);
        return { conn, status: { name, ok: true, toolCount: conn.tools.length } };
      } catch (e) {
        return { status: { name, ok: false, toolCount: 0, error: e instanceof Error ? e.message : String(e) } };
      }
    }),
  );
  const connections = results.map((r) => r.conn).filter((c): c is McpConnection => !!c);
  const tools = connections.flatMap((conn) => conn.tools.map((t) => mcpToolAdapter(conn, t)));
  return {
    connections,
    tools,
    status: results.map((r) => r.status),
    async closeAll() { await Promise.all(connections.map((c) => c.close())); },
  };
}
