import type { ChatRequest, Provider } from "../core/types.js";
import type { McpServerSpec } from "../config/config.js";
import { connectMcpServer } from "./client.js";

/**
 * Adding an MCP server from a documentation page, or from the command the page tells you to run.
 *
 * Every tool documents this the same way — "configure your host to run `npx -y @angular/cli mcp`" — and then
 * shows the same JSON three times, once per editor. Copying it into yet another config by hand is the kind
 * of work that is easy to get subtly wrong and impossible to debug: a mistyped argument produces a server
 * that starts, connects, and exposes nothing.
 *
 * So the spec is derived, and then VERIFIED by actually connecting before it is written. A config entry that
 * does not work is worse than no entry — it fails at startup, in a place the user is not looking.
 */

export interface InstallCandidate {
  name: string;
  spec: McpServerSpec;
  /** Where it came from, so the user can check the derivation rather than trust it. */
  source: string;
}

/** A page is fetched only to read its setup instructions; nothing on it is executed. */
export const MAX_PAGE_CHARS = 40_000;

/** Strips markup so the model reads prose and JSON rather than a wall of attributes. */
export function pageText(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
  return text.length > MAX_PAGE_CHARS ? text.slice(0, MAX_PAGE_CHARS) : text;
}

/**
 * Reads a command line the user pasted directly.
 *
 * Handled without a model because it is unambiguous: `npx -y @angular/cli mcp` is already the spec. Asking a
 * model to restate it would add a failure mode and a delay to the case that has neither.
 */
export function parseCommand(input: string): InstallCandidate | undefined {
  const t = input.trim();
  if (/^https?:\/\//i.test(t) || t.startsWith("{")) return undefined;
  const argv = t.match(/"[^"]*"|'[^']*'|\S+/g)?.map((a) => a.replace(/^['"]|['"]$/g, "")) ?? [];
  if (argv.length < 2) return undefined;
  if (!/^(npx|node|python3?|uvx|uv|bunx|deno|docker|sh|bash)$/.test(argv[0])) return undefined;
  return { name: guessName(argv), spec: { command: argv }, source: "the command you gave" };
}

/**
 * A name for the server, from the package it runs — this becomes the prefix on every tool it exposes.
 *
 * A scoped package keeps its scope: `@angular/cli` is `angular-cli`, not `cli`. Taking the last segment
 * named the Angular server "cli", which says nothing about what it is and would collide with the next
 * scoped package whose name happens to end the same way.
 */
function guessName(argv: string[]): string {
  const pkg = argv.slice(1).find((a) => !a.startsWith("-") && a !== "mcp");
  const raw = (pkg ?? argv[0]).replace(/^@/, "").replace(/@[^/]*$/, ""); // drop a leading @ and any @version
  return raw.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "server";
}

/** Reads a config block the user pasted — the shape every tool's docs print. */
export function parseConfigBlock(input: string): InstallCandidate | undefined {
  const t = input.trim();
  if (!t.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(t) as Record<string, unknown>;
    // Docs wrap it as {"mcpServers": {"<name>": {...}}} or {"servers": {...}}; a bare entry is also valid.
    const wrapper = (parsed.mcpServers ?? parsed.servers) as Record<string, Record<string, unknown>> | undefined;
    const [name, body] = wrapper
      ? Object.entries(wrapper)[0] ?? []
      : ["server", parsed as Record<string, unknown>];
    if (!body) return undefined;
    const spec = toSpec(body);
    return spec ? { name: name ?? "server", spec, source: "the configuration you pasted" } : undefined;
  } catch {
    return undefined;
  }
}

function toSpec(body: Record<string, unknown>): McpServerSpec | undefined {
  if (typeof body.url === "string") return { url: body.url };
  if (typeof body.command === "string") {
    const args = Array.isArray(body.args) ? body.args.filter((a): a is string => typeof a === "string") : [];
    return { command: [body.command, ...args] };
  }
  if (Array.isArray(body.command)) {
    const argv = body.command.filter((a): a is string => typeof a === "string");
    return argv.length ? { command: argv } : undefined;
  }
  return undefined;
}

const EXTRACT = (url: string, text: string): string =>
  `This page documents how to install an MCP (Model Context Protocol) server. Extract the server ` +
  `configuration.\n\n` +
  `Pages usually show the SAME server several times, once per editor (Cursor, VS Code, Claude Code, …). ` +
  `They differ only in which file the JSON goes in — the server itself is the same. Return it ONCE.\n\n` +
  `Answer with a fenced json block:\n` +
  `{"name":"<short identifier>","command":["<program>","<arg>", …]}\n` +
  `or, for a remote server:\n` +
  `{"name":"<short identifier>","url":"https://…"}\n\n` +
  `Rules:\n` +
  `- Take the command EXACTLY as documented, including flags like -y. A missing flag produces a server that ` +
  `hangs on a prompt nobody can see.\n` +
  `- Do not invent a command. If the page does not state one, answer {"name":"","command":[]}.\n` +
  `- The name becomes the prefix on every tool the server exposes: short, lowercase, no spaces.\n\n` +
  `Page: ${url}\n\n${text}`;

/** Derives the spec from a documentation page. */
export async function extractFromPage(opts: {
  provider: Provider;
  model: string;
  url: string;
  html: string;
  signal?: AbortSignal;
}): Promise<InstallCandidate | undefined> {
  const req: ChatRequest = {
    model: opts.model,
    messages: [
      { role: "system", content: "You extract MCP server configuration from documentation. You never invent a command." },
      { role: "user", content: EXTRACT(opts.url, pageText(opts.html)) },
    ],
    tools: [],
  };
  let out = "";
  for await (const ev of opts.provider.chat(req, opts.signal ?? new AbortController().signal)) {
    if (ev.type === "text-delta") out += ev.text;
    else if (ev.type === "error") throw new Error(ev.message);
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(out);
  try {
    const parsed = JSON.parse(fence ? fence[1] : out.slice(out.indexOf("{"))) as
      { name?: string; command?: unknown; url?: unknown };
    const spec = toSpec(parsed as Record<string, unknown>);
    if (!spec) return undefined;
    const name = (parsed.name ?? "").trim() || guessName("command" in spec ? spec.command : ["server"]);
    return { name, spec, source: opts.url };
  } catch {
    return undefined;
  }
}

export interface VerifyResult {
  ok: boolean;
  tools: { name: string; readOnly: boolean }[];
  error?: string;
}

/**
 * Starts the server and asks what it exposes.
 *
 * The whole point of installing from a link is that the user did not check the command themselves — so
 * something has to. A server that starts but exposes nothing is the common failure, and it is silent: it
 * would sit in the config looking installed while every agent got no tools from it.
 */
export async function verify(spec: McpServerSpec, name: string, timeoutMs = 60_000): Promise<VerifyResult> {
  try {
    const conn = await Promise.race([
      connectMcpServer(name, spec),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("it did not respond in time")), timeoutMs)),
    ]);
    const tools = conn.tools.map((t) => ({ name: t.name, readOnly: t.readOnly }));
    await conn.close();
    if (!tools.length) return { ok: false, tools: [], error: "it connected but exposes no tools" };
    return { ok: true, tools };
  } catch (e) {
    return { ok: false, tools: [], error: e instanceof Error ? e.message : String(e) };
  }
}
