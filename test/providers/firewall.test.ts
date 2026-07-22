import { describe, it, expect } from "vitest";
import { firewallProvider } from "../../src/providers/firewall.js";
import { MockProvider } from "../../src/providers/mock.js";
import type { ChatRequest } from "../../src/core/types.js";

const drain = async (it: AsyncIterable<unknown>): Promise<void> => { for await (const _ of it) { /* consume */ } };

describe("firewallProvider", () => {
  it("redacts secrets from outgoing messages before they reach the inner provider", async () => {
    const inner = new MockProvider([[{ type: "done", finishReason: "stop" }]]);
    const fw = firewallProvider(inner);
    const req: ChatRequest = {
      model: "m",
      messages: [
        { role: "system", content: "be helpful" },
        { role: "user", content: "here is my key AKIAIOSFODNN7EXAMPLE please use it" },
      ],
      tools: [],
    };
    await drain(fw.chat(req, new AbortController().signal));
    const sent = inner.requests[0].messages;
    expect(sent[1].content).toContain("[REDACTED:aws-key]");
    expect(sent[1].content).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(sent[0].content).toBe("be helpful"); // clean message untouched
  });
});
