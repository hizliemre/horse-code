import { describe, it, expect } from "vitest";
import { createWebFetchTool, type FetchLike } from "../../src/tools/web.js";

const ctx = () => ({ cwd: "/tmp", signal: new AbortController().signal });

describe("web_fetch", () => {
  it("200 yanıtın gövdesini döner", async () => {
    const fetch: FetchLike = async () => new Response("merhaba dünya", { status: 200 });
    const tool = createWebFetchTool(fetch);
    const res = await tool.run({ url: "https://example.com" }, ctx());
    expect(res).toEqual({ content: "merhaba dünya", isError: false });
  });

  it("hata durumunda (4xx) isError:true", async () => {
    const fetch: FetchLike = async () => new Response("not found", { status: 404 });
    const tool = createWebFetchTool(fetch);
    const res = await tool.run({ url: "https://example.com/x" }, ctx());
    expect(res.isError).toBe(true);
  });

  it("fetch reddi isError'a dönüşür (throw etmez)", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("ağ yok");
    };
    const tool = createWebFetchTool(fetch);
    const res = await tool.run({ url: "https://example.com" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("ağ yok");
  });

  it("geçersiz args (bozuk url) fetch'i hiç çağırmadan isError:true döner", async () => {
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
