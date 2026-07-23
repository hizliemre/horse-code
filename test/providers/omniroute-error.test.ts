import { describe, it, expect } from "vitest";
import { readErrorMessage, isRetryableStatus, isCapabilityError, OmniRouteProvider } from "../../src/providers/omniroute.js";
import type { FetchLike } from "../../src/providers/omniroute.js";

describe("isRetryableStatus", () => {
  it("429 and 5xx are retryable (source exhausted / upstream down); 4xx auth/validation are not", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
  });
});

describe("isCapabilityError", () => {
  it("flags model/subscription capability limits (a fallback may serve them)", () => {
    expect(isCapabilityError("The long context beta is not yet available for this subscription.")).toBe(true);
    expect(isCapabilityError("context length exceeded")).toBe(true);
    expect(isCapabilityError("this feature is not supported")).toBe(true);
    expect(isCapabilityError("invalid request: empty messages")).toBe(false);
  });
});

describe("OmniRouteProvider error events carry `retryable`", () => {
  const drain = async (p: OmniRouteProvider) => {
    const out = [];
    for await (const e of p.chat({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [] }, new AbortController().signal)) out.push(e);
    return out;
  };
  it("a 429 response → retryable error", async () => {
    const fetch: FetchLike = async () => new Response(JSON.stringify({ error: { message: "rate limit" } }), { status: 429 });
    const events = await drain(new OmniRouteProvider({ baseUrl: "http://x", fetch }));
    expect(events.at(-1)).toMatchObject({ type: "error", retryable: true });
  });
  it("a 401 response → non-retryable error", async () => {
    const fetch: FetchLike = async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    const events = await drain(new OmniRouteProvider({ baseUrl: "http://x", fetch }));
    expect(events.at(-1)).toMatchObject({ type: "error", retryable: false });
  });
  it("a capability 400 (long-context beta) → retryable so a fallback model can serve it", async () => {
    const fetch: FetchLike = async () => new Response(JSON.stringify({ error: { message: "The long context beta is not yet available for this subscription." } }), { status: 400 });
    const events = await drain(new OmniRouteProvider({ baseUrl: "http://x", fetch }));
    expect(events.at(-1)).toMatchObject({ type: "error", retryable: true });
  });
  it("a plain 400 (bad request) stays non-retryable", async () => {
    const fetch: FetchLike = async () => new Response(JSON.stringify({ error: { message: "invalid 'messages': empty" } }), { status: 400 });
    const events = await drain(new OmniRouteProvider({ baseUrl: "http://x", fetch }));
    expect(events.at(-1)).toMatchObject({ type: "error", retryable: false });
  });
  it("a network failure → retryable error", async () => {
    const fetch: FetchLike = async () => { throw new Error("fetch failed"); };
    const events = await drain(new OmniRouteProvider({ baseUrl: "http://x", fetch }));
    expect(events.at(-1)).toMatchObject({ type: "error", retryable: true });
  });
});

describe("readErrorMessage", () => {
  it("reads the 401 plain-string error format", async () => {
    const res = new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    expect(await readErrorMessage(res)).toBe("Unauthorized");
  });

  it("reads the object error.message format", async () => {
    const res = new Response(JSON.stringify({ error: { message: "rate limit", type: "rate_limit" } }), {
      status: 429,
    });
    expect(await readErrorMessage(res)).toBe("rate limit");
  });

  it("falls back to status for a non-JSON body", async () => {
    const res = new Response("upstream boom", { status: 502 });
    expect(await readErrorMessage(res)).toBe("omniroute 502");
  });
});
