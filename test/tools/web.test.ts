import { describe, it, expect } from "vitest";
import { createWebFetchTool, type FetchLike } from "../../src/tools/web.js";

const ctx = () => ({ cwd: "/tmp", signal: new AbortController().signal });

describe("web_fetch", () => {
  it("returns the body of a 200 response", async () => {
    const fetch: FetchLike = async () => new Response("hello world", { status: 200 });
    const tool = createWebFetchTool(fetch);
    const res = await tool.run({ url: "https://example.com" }, ctx());
    expect(res).toEqual({ content: "hello world", isError: false });
  });

  it("isError:true on error (4xx)", async () => {
    const fetch: FetchLike = async () => new Response("not found", { status: 404 });
    const tool = createWebFetchTool(fetch);
    const res = await tool.run({ url: "https://example.com/x" }, ctx());
    expect(res.isError).toBe(true);
  });

  it("a fetch rejection becomes isError (does not throw)", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("no network");
    };
    const tool = createWebFetchTool(fetch);
    const res = await tool.run({ url: "https://example.com" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("no network");
  });

  it("invalid args (malformed url) return isError:true without ever calling fetch", async () => {
    let called = false;
    const fetch: FetchLike = async () => {
      called = true;
      return new Response("", { status: 200 });
    };
    const tool = createWebFetchTool(fetch);
    const res = await tool.run({ url: "not-a-url" }, ctx());
    expect(res.isError).toBe(true);
    expect(called).toBe(false);
  });
});
