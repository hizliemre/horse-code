import { describe, it, expect } from "vitest";
import { listOmniRouteModels } from "../../src/providers/models.js";
import type { FetchLike } from "../../src/providers/omniroute.js";

function fakeFetch(body: unknown, ok = true, status = 200): FetchLike {
  return async () => new Response(JSON.stringify(body), { status: ok ? status : status });
}

describe("listOmniRouteModels", () => {
  it("returns sorted, de-duplicated ids from data[]", async () => {
    const fetch = fakeFetch({ data: [{ id: "b/two" }, { id: "a/one" }, { id: "a/one" }] });
    const ids = await listOmniRouteModels({ baseUrl: "http://x", fetch });
    expect(ids).toEqual(["a/one", "b/two"]);
  });

  it("sends Authorization header when apiKey is given, hits /api/v1/models", async () => {
    let seenUrl = ""; let seenAuth: string | null = null;
    const fetch: FetchLike = async (url, init) => {
      seenUrl = url;
      seenAuth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
    await listOmniRouteModels({ baseUrl: "http://x/", apiKey: "k", fetch });
    expect(seenUrl).toBe("http://x/api/v1/models");
    expect(seenAuth).toBe("Bearer k");
  });

  it("throws on a non-ok response", async () => {
    const fetch: FetchLike = async () => new Response("", { status: 500 });
    await expect(listOmniRouteModels({ baseUrl: "http://x", fetch })).rejects.toThrow();
  });
});
