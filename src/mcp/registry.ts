import { z } from "zod";
import type { Tool } from "../core/types.js";
import type { McpServerSpec } from "../config/config.js";
import { connectMcpServer, type McpConnection, type McpTool } from "./client.js";

/** Prefixed, API-safe tool name: mcp__<server>__<tool>. */
export function mcpToolName(server: string, tool: string): string {
  const safe = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `mcp__${safe(server)}__${safe(tool)}`;
}

/**
 * Wraps one MCP tool as a horse-code Tool.
 *
 * A read-only tool is `safe`: it cannot change anything, so stopping the user to approve a graph lookup buys
 * no safety and costs the autonomy the pipeline is for. Everything else stays `exec` and goes through the
 * approval gate.
 */
export function mcpToolAdapter(conn: McpConnection, tool: McpTool): Tool {
  const name = mcpToolName(conn.name, tool.name);
  return {
    name,
    description: `[MCP:${conn.name}] ${tool.description ?? tool.name}`,
    permissionLevel: tool.readOnly ? "safe" : "exec",
    parameters: z.record(z.string(), z.unknown()), // unused — rawSchema is what the model sees
    rawSchema: tool.inputSchema, // MCP provides a JSON Schema; send it verbatim
    describe: (args) => ({ allowKey: `mcp:${conn.name}:${tool.name}`, preview: `mcp ${conn.name}/${tool.name} ${JSON.stringify(args)}`.slice(0, 200) }),
    async run(args) {
      try {
        const res = await conn.callTool(tool.name, args as Record<string, unknown>);
        return { content: res.content, isError: res.isError };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { content: explainMcpError(name, message, tool.inputSchema), isError: true };
      }
    },
  };
}

/** Longest schema excerpt attached to an error. Enough to correct a call, not enough to flood the turn. */
export const MAX_SCHEMA_HINT = 700;

/**
 * A server's own fault, as opposed to a bad call.
 *
 * The wire code for both is -32602, so the code alone cannot tell them apart. A server whose response fails
 * ITS OWN declared output schema has produced a broken reply to a valid request — and the important thing to
 * say about that is that calling again with the same arguments will fail again in exactly the same way. An
 * agent not told this retries the identical call until it runs out of turns.
 */
export function isServerFault(message: string): boolean {
  return /structured content does not match|output schema|invalid response|malformed (response|result)/i.test(message);
}

/**
 * What to tell the agent when a tool call fails.
 *
 * A terse "MCP error -32602" gives it nothing to act on. Either the call was wrong — in which case the
 * schema it should have matched is what it needs — or the server misbehaved, in which case the one useful
 * instruction is not to keep trying.
 */
export function explainMcpError(name: string, message: string, inputSchema: unknown): string {
  if (isServerFault(message)) {
    return `${name}: ${message}\n\nThis is the server returning a reply that fails its own declared schema — ` +
      `your call was well-formed, so repeating it will fail identically. Get what you need another way, and ` +
      `say in your answer that this tool is broken.`;
  }
  let schema = "";
  try {
    const json = JSON.stringify(inputSchema);
    if (json && json !== "{}" && json !== "null") {
      schema = json.length > MAX_SCHEMA_HINT ? `${json.slice(0, MAX_SCHEMA_HINT)}…` : json;
    }
  } catch { /* unserialisable schema → the message alone has to do */ }
  return schema
    ? `${name}: ${message}\n\nArguments must match: ${schema}\nCorrect them and call it again.`
    : `${name}: ${message}`;
}

export interface McpStatus {
  name: string;
  ok: boolean;
  toolCount: number;
  error?: string;
}

export interface McpBundle {
  connections: McpConnection[];
  /** Every adapted tool. Only the agent trusted with exec-level tools should be given this whole set. */
  tools: Tool[];
  /**
   * The subset that only reads.
   *
   * These go to EVERY agent. An agent that cannot see the project it is changing is the problem this exists
   * to solve: a coder about to edit a function needs to know what calls it, and a reviewer needs to know what
   * a change can reach. Withholding a read-only lookup from them buys nothing.
   */
  readOnlyTools: Tool[];
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
    readOnlyTools: tools.filter((t) => t.permissionLevel === "safe"),
    status: results.map((r) => r.status),
    async closeAll() { await Promise.all(connections.map((c) => c.close())); },
  };
}
