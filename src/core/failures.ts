/**
 * What a model failure is ABOUT — the taxonomy the whole retry, bench and ladder machinery is built on.
 *
 * These predicates were written against one gateway's wording and lived beside its transport, which made
 * them look like a property of that gateway. They are not. Every one of them answers the same question in a
 * different vocabulary — is this about the request, this model, or the source serving it? — and the answer
 * decides whether a call falls back, whether a model is benched, and whether a task pays for it with an
 * attempt. An official CLI is rate-limited by its subscription exactly as a gateway is by its account, so
 * the taxonomy outlives the transport that taught it to us.
 *
 * The measurements in each comment are from real runs and are the reason each line exists; they are kept
 * with the code they justify rather than summarised, because a rule without its measurement is a guess that
 * the next reader has to re-derive.
 */

/**
 * A 400 that reflects THIS model/subscription's capability limits rather than a malformed request — e.g.
 * "long context beta not available for this subscription", context-window overflow, or an unsupported feature.
 * A fallback model on a different subscription may well accept the same request, so treat these as retryable.
 *
 * The verb is matched in every form the gateway uses, because it does not use only one. Measured 20 minutes
 * into a run: "This model does not support the effort parameter." is exactly this case — one model refusing
 * one request field that a fallback would accept — and it matched nothing. `not supported` is a different
 * string from `not support the`, so the 400 was neither retryable nor a capability refusal and the call died
 * where it should have stepped sideways.
 */
export function isCapabilityError(message: string): boolean {
  return /long[- ]context|not (yet )?available for this subscription|context[- ](length|window)|too many tokens|maximum context|unsupported|\bnot support(?:s|ed)?\b/i.test(message);
}

/**
 * A provider whose credentials are absent — an outage of one SOURCE, not a fault of one model.
 *
 * Measured across two runs: `No active credentials for provider: antigravity.` arrives as HTTP 401, which
 * `isRetryableStatus` rightly calls unretryable, and it is not a capability refusal or an unknown model
 * either. So the chain did neither of the two things it should: no fallback to the next model, and no call
 * to `onExhausted` — which meant the provider-wide bench added for exactly this failure was dead code. 233
 * of one run's 562 model errors were this one sentence, repeated.
 *
 * Retryable is the right reading: the request is fine and a model on ANY other provider can serve it. It
 * must also reach the bench, so `noBench` is deliberately NOT set — that flag is for a refusal that says
 * nothing about the model's health, and a source with no credentials is the opposite.
 *
 * Narrow on purpose. It matches a message that names a PROVIDER, so a 401 about the gateway key itself —
 * which no fallback can fix — does not qualify and still ends the call.
 */
export function isProviderOutage(message: string): boolean {
  return /no active credentials for provider:?\s*[\w.-]+/i.test(message)
    || /provider\s+'?[\w.-]+'?\s+is not configured/i.test(message)
    /**
     * A spent quota is a source-wide failure too, and it was the third phrasing to reach this the hard way.
     *
     * Measured two minutes into a run: "[antigravity/claude-sonnet-4-6-medium] All antigravity accounts have
     * exhausted their quota (reset after 4h)" — six times across two models, with ZERO quarantine events. No
     * credentials and no quota left are the same situation for a chain: this source cannot serve, another
     * can. Matching only the credential wording meant every role holding an antigravity model would walk
     * into the same wall for the whole four-hour window.
     *
     * The bench this opens is for the run, not for the stated reset window. That is deliberately pessimistic
     * and deliberately simple; a run shorter than the reset loses nothing, and a longer one loses a source it
     * would otherwise have spent the window rediscovering.
     */
    || /all\s+[\w.-]+\s+accounts have exhausted their quota/i.test(message)
    /**
     * A shared egress IP belongs to the source. Measured in 30 minutes of one run: twenty-three distinct
     * models each discovered the same exhausted IP independently, across the whole of one provider's
     * catalogue, with a reset roughly five days out. See `providerOutage` for the list.
     */
    || /shared egress ip quota exhausted/i.test(message);
}

/**
 * The gateway could not resolve the MODEL ID it was given.
 *
 * "Unable to determine provider for model 'default'" is a statement about the id, not about any model's
 * health — and the id in it is usually not even one of the models the failing role was assigned. Benching on
 * it is how one bad id took the whole pool down: each failure quarantined three working models and re-chained
 * fifty-eight roles onto a shrinking pool, which produced the next failure. Falling to the next model is
 * still right; writing this one off is not.
 */
export function isUnknownModelError(message: string): boolean {
  return /unable to determine provider for model|unknown model|model not found|no such model|invalid model/i.test(message);
}

/**
 * The gateway resolved the id, found the model in its catalog, and refused to route to it.
 *
 * "Model 'hy3' is not available in the active live catalog for provider 'opencode-go'" arrives as a 400,
 * which is not a retryable status, so the chain first stopped dead on a model it could simply have skipped —
 * a 16-hour run ended on this error one line after delivering its work. Making it retryable fixed that.
 *
 * But it was folded into `isUnknownModelError`, and that carries `noBench`, which was the more expensive
 * half of the mistake. The two rejections are opposites:
 *
 *   - an unresolvable id says nothing about any model's health, and the id is usually not even one of the
 *     models the failing role holds — benching on it takes working models out of service;
 *   - a catalog rejection names ONE specific model that a role's chain is really pointing at, and that model
 *     is dead for the rest of the run. It is exactly what the bench is for.
 *
 * Measured over a 705-minute run: 212 of 557 model errors were this, spread across six models
 * (`cx/codex-auto-review`, `opencode-go/hy3`, `hy3-none`, `hy3-high`, `muse-spark-1.2-contributor`,
 * `-minimal`). The chain did fall back every time — and then every later role, on every later task, walked
 * into the same six models again, because none of them was ever written off.
 *
 * Anchored on the catalog wording rather than on "not available" alone: "the long context beta is not yet
 * available for this subscription" is a CAPABILITY refusal, which falls back without benching, and a healthy
 * model must not be quarantined for a request that did not fit it.
 */
export function isCatalogRejection(message: string): boolean {
  return /not (?:currently )?available in the [^.]{0,40}catalog/i.test(message);
}
