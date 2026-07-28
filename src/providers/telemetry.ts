import type { Provider } from "../core/types.js";
import type { Telemetry } from "../obs/telemetry.js";

/**
 * Records every model call as a span: which model, how long, how many tokens, and how it ended.
 *
 * A wrapper rather than instrumentation at the call sites, for the same reason the meter and the firewall are
 * wrappers: every model call in the system goes through `Provider.chat`, so one place catches all of them and
 * no future call site can forget.
 *
 * Attributes follow OpenTelemetry's GenAI conventions (`gen_ai.*`), so a Grafana dashboard built for LLM
 * applications reads this log without a translation layer.
 */
export function telemetryProvider(inner: Provider, tel: Telemetry): Provider {
  return {
    chat(req, signal) {
      return stream(inner, tel, req, signal);
    },
  };
}

async function* stream(
  inner: Provider,
  tel: Telemetry,
  req: Parameters<Provider["chat"]>[0],
  signal: Parameters<Provider["chat"]>[1],
): ReturnType<Provider["chat"]> {
  /**
   * The span closes when the stream is DONE, not when `chat` returns.
   *
   * A streaming call returns its generator immediately; the time that matters is spent draining it. Wrapping
   * the call in `tel.span` would have recorded microseconds for a request that took four minutes.
   */
  const started = Date.now();
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let cachedTokens: number | undefined;
  let finish: string | undefined;
  let failure: string | undefined;
  let toolCalls = 0;
  let textChars = 0;
  try {
    for await (const ev of inner.chat(req, signal)) {
      if (ev.type === "usage") {
        promptTokens = ev.promptTokens;
        completionTokens = ev.completionTokens;
        cachedTokens = ev.cachedTokens;
      } else if (ev.type === "tool-call") toolCalls++;
      else if (ev.type === "text-delta") textChars += ev.text.length;
      else if (ev.type === "done") finish = ev.finishReason;
      else if (ev.type === "error") failure = ev.message;
      yield ev;
    }
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    tel.event("gen_ai.chat", {
      "gen_ai.system": "omniroute",
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": req.model,
      "gen_ai.usage.input_tokens": promptTokens,
      "gen_ai.usage.output_tokens": completionTokens,
      "gen_ai.usage.cached_tokens": cachedTokens,
      "gen_ai.response.finish_reason": finish,
      "hc.duration_ms": Date.now() - started,
      "hc.tools_requested": toolCalls,
      "hc.text_chars": textChars,
      "hc.tools_offered": req.tools?.length ?? 0,
      "hc.messages": req.messages.length,
      ...(failure ? { "hc.error": failure.slice(0, 300) } : {}),
      "hc.status": failure ? "error" : "ok",
    });
  }
}
