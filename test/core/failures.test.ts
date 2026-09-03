import { describe, it, expect } from "vitest";
import { isCapabilityError, isProviderOutage, isUnknownModelError, isCatalogRejection } from "../../src/core/failures.js";

/**
 * The taxonomy's own tests, moved here with it.
 *
 * They were written against one gateway's wording and sat beside its transport, which made them read as
 * tests OF that gateway. Each is really a test of the same question — is this failure about the request,
 * this model, or the source serving it? — and the answer decides whether a call falls back, whether a model
 * is benched, and whether a task pays for it with an attempt. That outlives any one transport.
 *
 * The transport-level tests stayed behind: how a 400 becomes a retryable event is the gateway's business.
 */

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

  it("is recognised", () => {
    expect(isProviderOutage(LIVE)).toBe(true);
    expect(isProviderOutage("Provider 'opencode-go' is not configured")).toBe(true);
    /**
     * A spent quota is the same fact about the same source. Measured two minutes into a run: six of these
     * across two models and no quarantine at all, because only the credential wording was known.
     */
    expect(isProviderOutage("[antigravity/claude-sonnet-4-6-medium] All antigravity accounts have exhausted their quota (reset after 4h)")).toBe(true);
    /**
     * And a shared egress IP is the source's too — measured across TWENTY-THREE models of one provider in
     * half an hour, each rediscovering the same exhausted IP on its own. See `providerOutage`.
     */
    expect(isProviderOutage("[opencode-go/deepseek-v4-pro] Shared egress IP quota exhausted (opencode-go) (reset after 114h 2m)")).toBe(true);
  });

  /** A 401 about the gateway key itself is not this: no fallback can fix it, and it must still end the call. */
  it("does not swallow an auth failure that names no provider", () => {
    expect(isProviderOutage("Invalid API key")).toBe(false);
    expect(isProviderOutage("Unauthorized")).toBe(false);
    expect(isProviderOutage("authentication_error")).toBe(false);
  });

  it("is not confused by failures that are about one model", () => {
    for (const m of ["Overloaded",
      "Model 'hy3' is not available in the active live catalog for provider 'opencode-go'."]) {
      expect(isProviderOutage(m), m).toBe(false);
    }
  });
});
