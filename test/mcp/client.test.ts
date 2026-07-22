import { describe, it, expect } from "vitest";
import { renderContent } from "../../src/mcp/client.js";

describe("renderContent (MCP tool-result flattening)", () => {
  it("joins text content blocks with newlines", () => {
    expect(renderContent([{ type: "text", text: "line1" }, { type: "text", text: "line2" }])).toBe("line1\nline2");
  });

  it("labels non-text blocks by their type", () => {
    expect(renderContent([{ type: "text", text: "ok" }, { type: "image", data: "…" }])).toBe("ok\n[image]");
    expect(renderContent([{ type: "resource" }])).toBe("[resource]");
    expect(renderContent([{}])).toBe("[content]"); // no type → generic label
  });

  it("handles a plain string and non-array shapes", () => {
    expect(renderContent("just text")).toBe("just text");
    expect(renderContent({ ok: true })).toBe('{"ok":true}');
  });
});
