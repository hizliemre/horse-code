import { describe, it, expect } from "vitest";
import { readErrorMessage, isRetryableStatus, isCapabilityError, OmniRouteProvider, isUnknownModelError } from "../../src/providers/omniroute.js";
import type { FetchLike } from "../../src/providers/omniroute.js";

describe("isRetryableStatus", () => {
  it("429, 404 (model not found) and 5xx are retryable; 400/401/403 auth/validation are not", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(404)).toBe(true); // model unavailable on this subscription → a fallback may serve it
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

/**
 * Listed is not the same as routable, and a model that is only the first ended a 16-hour run.
 *
 * Measured: a fallback picked `opencode-go/hy3`, which IS in the gateway's catalog of 726 models, and the
 * request came back 400 `invalid_request_error` — "Model 'hy3' is not available in the active live catalog
 * for provider 'opencode-go'." 400 is not a retryable status and the phrasing matched none of the patterns,
 * so the chain stopped on a model it could have skipped, one line after the work had been delivered.
 */
describe("a model the catalog lists and the router refuses", () => {
  const LIVE = "Model 'hy3' is not available in the active live catalog for provider 'opencode-go'.";

  it("recognises the gateway's own words for it", () => {
    expect(isUnknownModelError(LIVE)).toBe(true);
  });

  it("keeps recognising the phrasings it already knew", () => {
    for (const m of ["unknown model: x", "model not found", "no such model", "invalid model",
      "unable to determine provider for model foo"]) {
      expect(isUnknownModelError(m), m).toBe(true);
    }
  });

  /**
   * A capability refusal is a different case with a different remedy — fall back WITHOUT benching, because
   * the model is fine and this request did not fit it. Collapsing the two would quarantine a healthy model.
   */
  it("does not swallow a capability refusal", () => {
    expect(isUnknownModelError("The long context beta is not yet available for this subscription")).toBe(false);
    expect(isUnknownModelError("This model does not support tool use")).toBe(false);
  });

  it("does not fire on ordinary trouble that happens to mention availability", () => {
    expect(isUnknownModelError("Overloaded")).toBe(false);
    expect(isUnknownModelError("upstream is not available right now, retry")).toBe(false);
  });
});
