import type { Provider } from "../core/types.js";

export interface UsageSample {
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Wraps a provider and reports each call's model + token usage as it streams. The role/stage that made
 * the call isn't in the request, so the UI pairs this with the current phase for the "active role" label.
 */
export function meterProvider(inner: Provider, onUsage: (s: UsageSample) => void): Provider {
  return {
    async *chat(req, signal) {
      for await (const ev of inner.chat(req, signal)) {
        if (ev.type === "usage") {
          onUsage({ model: req.model, promptTokens: ev.promptTokens, completionTokens: ev.completionTokens });
        }
        yield ev;
      }
    },
  };
}
