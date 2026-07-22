import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpServerSpec } from "../config/config.js";
import { VERSION } from "../version.js";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: unknown; // JSON Schema (draft-7) as provided by the server
}

export interface McpConnection {
  name: string;
  tools: McpTool[];
  callTool(tool: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }>;
  close(): Promise<void>;
}

/** Flattens an MCP tool-result content array into text the model can read. */
function renderContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : JSON.stringify(content);
  return content
    .map((c) => {
      const block = c as { type?: string; text?: string };
      if (block.type === "text" && typeof block.text === "string") return block.text;
      return `[${block.type ?? "content"}]`;
    })
    .join("\n");
}

function clientFor(): Client {
  return new Client({ name: "horse-code", version: VERSION }, { capabilities: {} });
}

/** Connect a remote server: try streamable-HTTP first, fall back to SSE on failure. */
async function connectRemote(url: string, headers?: Record<string, string>): Promise<Client> {
  const target = new URL(url);
  const init = headers ? { requestInit: { headers } } : undefined;
  try {
    const client = clientFor();
    await client.connect(new StreamableHTTPClientTransport(target, init));
    return client;
  } catch {
    const client = clientFor();
    await client.connect(new SSEClientTransport(target, init));
    return client;
  }
}

/** Connects to one MCP server (stdio or remote), lists its tools, and returns a handle. */
export async function connectMcpServer(name: string, spec: McpServerSpec): Promise<McpConnection> {
  const client = "command" in spec
    ? await (async (): Promise<Client> => {
        const c = clientFor();
        await c.connect(new StdioClientTransport({
          command: spec.command[0],
          args: spec.command.slice(1),
          env: { ...process.env as Record<string, string>, ...(spec.env ?? {}) },
        }));
        return c;
      })()
    : await connectRemote(spec.url, spec.headers);

  const listed = await client.listTools();
  const tools: McpTool[] = listed.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  return {
    name,
    tools,
    async callTool(tool, args) {
      const res = await client.callTool({ name: tool, arguments: args });
      return { content: renderContent(res.content), isError: res.isError === true };
    },
    async close() {
      await client.close().catch(() => { /* best-effort */ });
    },
  };
}
