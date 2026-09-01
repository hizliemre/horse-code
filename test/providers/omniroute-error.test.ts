import { describe, it, expect } from "vitest";
import { readErrorMessage, isRetryableStatus, isCapabilityError, OmniRouteProvider, isUnknownModelError, isCatalogRejection, isProviderOutage } from "../../src/providers/omniroute.js";
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

  /**
   * The gateway does not use one form of the verb, and matching only `not supported` cost the call.
   *
   * Measured 20 minutes into a run: "This model does not support the effort parameter." — one model refusing
   * one request field a fallback would accept. It is not a retryable status and matched no capability
   * phrasing, so the call died instead of stepping sideways.
   */
  it("reads the verb in every form the gateway writes it", () => {
    for (const m of ["This model does not support the effort parameter.",
      "this feature is not supported", "the parameter is unsupported"]) {
      expect(isCapabilityError(m), m).toBe(true);
    }
  });

  it("still refuses a malformed request that merely mentions support", () => {
    expect(isCapabilityError("invalid 'messages': empty")).toBe(false);
    expect(isCapabilityError("contact support for details")).toBe(false);
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
    expect(isCatalogRejection(LIVE)).toBe(true);
  });

  /**
   * The two rejections read alike and mean opposite things, so each predicate must refuse the other's case.
   * Folding the catalog wording into `isUnknownModelError` is what carried `noBench` onto a dead model.
   */
  it("is not the same thing as an id the gateway cannot resolve", () => {
    expect(isUnknownModelError(LIVE)).toBe(false);
    expect(isCatalogRejection("unable to determine provider for model 'default'")).toBe(false);
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
    for (const m of ["The long context beta is not yet available for this subscription",
      "This model does not support tool use"]) {
      expect(isUnknownModelError(m), m).toBe(false);
      expect(isCatalogRejection(m), m).toBe(false);
    }
  });

  it("does not fire on ordinary trouble that happens to mention availability", () => {
    for (const m of ["Overloaded", "upstream is not available right now, retry"]) {
      expect(isUnknownModelError(m), m).toBe(false);
      expect(isCatalogRejection(m), m).toBe(false);
    }
  });

  /**
   * The measured cost of getting this wrong: 212 of one 705-minute run's 557 model errors were catalog
   * rejections across six models. The chain fell back every time and benched none of them, so every later
   * role on every later task walked into the same six again. Retryable AND benchable is the whole fix.
   */
  it("is retryable and reaches the bench, unlike an unresolvable id", async () => {
    const errorFor = async (message: string) => {
      const fetch: FetchLike = async () => new Response(JSON.stringify({ error: { message } }), { status: 400 });
      const p = new OmniRouteProvider({ baseUrl: "http://x", fetch });
      const out = [];
      for await (const e of p.chat({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [] }, new AbortController().signal)) out.push(e);
      return out.at(-1) as { retryable?: boolean; noBench?: boolean };
    };

    const catalog = await errorFor(LIVE);
    expect(catalog.retryable).toBe(true);
    expect(catalog.noBench).toBeUndefined();

    const badId = await errorFor("Unable to determine provider for model 'default'");
    expect(badId.retryable).toBe(true);
    expect(badId.noBench).toBe(true);
  });
});

/**
 * A provider with no credentials was neither retried nor benched, so the bench built for it never ran.
 *
 * Measured across two runs: `No active credentials for provider: antigravity.` arrives as HTTP 401.
 * `isRetryableStatus` calls 401 unretryable — correctly, for an auth failure nothing can fix — and it is
 * not a capability refusal or an unknown model either. So `loop.ts` did neither of the two things it
 * should: no fallback to the next model, and no call to `onExhausted`. The provider-wide bench added for
 * exactly this failure was dead code, and 233 of one run's 562 model errors were this one sentence.
 */
describe("a provider whose credentials are gone", () => {
  const LIVE = "No active credentials for provider: antigravity.";
  const drain = async (p: OmniRouteProvider) => {
    const out = [];
    for await (const e of p.chat({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [] },
      new AbortController().signal)) out.push(e);
    return out;
  };

  it("is recognised", () => {
    expect(isProviderOutage(LIVE)).toBe(true);
    expect(isProviderOutage("Provider 'opencode-go' is not configured")).toBe(true);
    /**
     * A spent quota is the same fact about the same source. Measured two minutes into a run: six of these
     * across two models and no quarantine at all, because only the credential wording was known.
     */
    expect(isProviderOutage("[antigravity/claude-sonnet-4-6-medium] All antigravity accounts have exhausted their quota (reset after 4h)")).toBe(true);
  });

  /** A 401 about the gateway key itself is not this: no fallback can fix it, and it must still end the call. */
  it("does not swallow an auth failure that names no provider", () => {
    expect(isProviderOutage("Invalid API key")).toBe(false);
    expect(isProviderOutage("Unauthorized")).toBe(false);
    expect(isProviderOutage("authentication_error")).toBe(false);
  });

  it("is not confused by failures that are about one model", () => {
    for (const m of ["Overloaded", "Shared egress IP quota exhausted (opencode-go)",
      "Model 'hy3' is not available in the active live catalog for provider 'opencode-go'."]) {
      expect(isProviderOutage(m), m).toBe(false);
    }
  });

  it("reaches the chain as retryable, on a status that is otherwise not", async () => {
    const fetch: FetchLike = async () => new Response(JSON.stringify({ error: LIVE }), { status: 401 });
    const events = await drain(new OmniRouteProvider({ baseUrl: "http://x", fetch }));
    expect(events.at(-1)).toMatchObject({ type: "error", retryable: true });
  });

  /**
   * `noBench` must stay absent. It marks a refusal that says nothing about a model's health; a source with
   * no credentials is the opposite, and suppressing the bench here is what left it dead.
   */
  it("is allowed to bench the models it names", async () => {
    const fetch: FetchLike = async () => new Response(JSON.stringify({ error: LIVE }), { status: 401 });
    const events = await drain(new OmniRouteProvider({ baseUrl: "http://x", fetch }));
    expect((events.at(-1) as { noBench?: boolean }).noBench).toBeUndefined();
  });

  /** An ordinary 401 still ends the call — the narrowness is the point. */
  it("leaves a plain auth failure unretryable", async () => {
    const fetch: FetchLike = async () => new Response(JSON.stringify({ error: "Invalid API key" }), { status: 401 });
    const events = await drain(new OmniRouteProvider({ baseUrl: "http://x", fetch }));
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect((events.at(-1) as { retryable?: boolean }).retryable).toBeFalsy();
  });
});
