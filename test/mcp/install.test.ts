import { describe, it, expect } from "vitest";
import { parseCommand, parseConfigBlock, pageText, extractFromPage, MAX_PAGE_CHARS } from "../../src/mcp/install.js";
import type { Provider } from "../../src/core/types.js";

const canned = (text: string): Provider => ({
  chat: async function* () { yield { type: "text-delta" as const, text }; },
} as unknown as Provider);

describe("parseCommand — the command a page tells you to run", () => {
  it("reads it exactly as given", () => {
    expect(parseCommand("npx -y @angular/cli mcp")?.spec).toEqual({ command: ["npx", "-y", "@angular/cli", "mcp"] });
  });

  /**
   * A scoped package keeps its scope. Taking the last path segment named the Angular server "cli", which
   * says nothing about what it is and collides with the next package ending the same way.
   */
  it("names a scoped package by its full name", () => {
    expect(parseCommand("npx -y @angular/cli mcp")?.name).toBe("angular-cli");
  });

  it("names an unscoped package by itself", () => {
    expect(parseCommand("npx -y some-mcp-server")?.name).toBe("some-mcp-server");
  });

  it("drops a pinned version from the name", () => {
    expect(parseCommand("npx -y @scope/thing@1.2.3 mcp")?.name).toBe("scope-thing");
  });

  it("handles quoted arguments", () => {
    expect(parseCommand('node "/path with spaces/server.js"')?.spec)
      .toEqual({ command: ["node", "/path with spaces/server.js"] });
  });

  /** Anything else is not a command, and guessing would run something the user did not ask for. */
  it.each(["https://angular.dev/ai/mcp", '{"mcpServers":{}}', "rm -rf /", "hello", "npx"])(
    "refuses %o", (input) => { expect(parseCommand(input)).toBeUndefined(); },
  );
});

describe("parseConfigBlock — the JSON every tool's docs print", () => {
  it("reads the mcpServers wrapper", () => {
    const got = parseConfigBlock('{"mcpServers":{"angular":{"command":"npx","args":["-y","@angular/cli","mcp"]}}}');
    expect(got).toMatchObject({ name: "angular", spec: { command: ["npx", "-y", "@angular/cli", "mcp"] } });
  });

  // VS Code calls the same block "servers".
  it("reads the servers wrapper too", () => {
    expect(parseConfigBlock('{"servers":{"x":{"command":"node","args":["s.js"]}}}')?.name).toBe("x");
  });

  it("reads a remote server", () => {
    expect(parseConfigBlock('{"mcpServers":{"r":{"url":"https://example.com/mcp"}}}')?.spec)
      .toEqual({ url: "https://example.com/mcp" });
  });

  it("reads a bare entry with no wrapper", () => {
    expect(parseConfigBlock('{"command":"node","args":["s.js"]}')?.spec).toEqual({ command: ["node", "s.js"] });
  });

  it.each(["not json", "{", '{"mcpServers":{"x":{}}}'])("refuses %o", (input) => {
    expect(parseConfigBlock(input)).toBeUndefined();
  });
});

describe("pageText", () => {
  it("strips markup and decodes entities so the JSON survives", () => {
    const t = pageText('<pre><code>{&quot;command&quot;: &quot;npx&quot;}</code></pre><script>x()</script>');
    expect(t).toContain('{"command": "npx"}');
    expect(t).not.toContain("x()");
  });

  it("caps an enormous page", () => {
    expect(pageText("<p>x</p>".repeat(50_000)).length).toBeLessThanOrEqual(MAX_PAGE_CHARS);
  });
});

describe("extractFromPage", () => {
  const run = (text: string) =>
    extractFromPage({ provider: canned(text), model: "m", url: "https://x/mcp", html: "<p>docs</p>" });

  it("takes the command the page documents", async () => {
    const got = await run('```json\n{"name":"angular-cli","command":["npx","-y","@angular/cli","mcp"]}\n```');
    expect(got).toMatchObject({ name: "angular-cli", spec: { command: ["npx", "-y", "@angular/cli", "mcp"] } });
    expect(got?.source).toBe("https://x/mcp");
  });

  it("takes a remote url", async () => {
    expect((await run('```json\n{"name":"r","url":"https://s/mcp"}\n```'))?.spec).toEqual({ url: "https://s/mcp" });
  });

  /** A page that documents no server must not produce one; inventing a command runs something arbitrary. */
  it("returns nothing when the page states no command", async () => {
    expect(await run('```json\n{"name":"","command":[]}\n```')).toBeUndefined();
  });

  it("returns nothing when the answer cannot be read", async () => {
    expect(await run("I could not find one.")).toBeUndefined();
  });

  it("tells the model that editors repeat the same server and not to invent one", async () => {
    let seen = "";
    const spy = {
      chat: async function* (req: { messages: { content: string }[] }) {
        seen = req.messages.map((m) => m.content).join("\n");
        yield { type: "text-delta" as const, text: '```json\n{"name":"","command":[]}\n```' };
      },
    } as unknown as Provider;
    await extractFromPage({ provider: spy, model: "m", url: "u", html: "h" });
    expect(seen).toMatch(/once per editor/);
    expect(seen).toMatch(/Return it ONCE/);
    expect(seen).toMatch(/Do not invent a command/);
    expect(seen).toMatch(/A missing flag produces a server that hangs/);
  });
});
