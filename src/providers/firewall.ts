import type { ChatEvent, ChatRequest, Provider } from "../core/types.js";
import { redactSecrets } from "../core/prompt-guard.js";

/**
 * Egress firewall: redacts credential-looking substrings from every outgoing message before the request
 * reaches the model — so secrets pulled into the prompt by read/shell/web tools never leave the machine.
 */
export function firewallProvider(inner: Provider): Provider {
  return {
    chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent> {
      const messages = req.messages.map((m) => {
        if (!m.content) return m;
        const { text } = redactSecrets(m.content);
        return text === m.content ? m : { ...m, content: text };
      });
      return inner.chat({ ...req, messages }, signal);
    },
  };
}
