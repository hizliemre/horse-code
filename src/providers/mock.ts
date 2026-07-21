import type { ChatEvent, ChatRequest, Provider } from "../core/types.js";

/**
 * Test double: emits a pre-scripted ChatEvent turn for each chat() call.
 * Deterministically tests multi-turn loops (tool-call → tool result → second turn).
 */
export class MockProvider implements Provider {
  private index = 0;
  readonly requests: ChatRequest[] = [];

  constructor(private turns: ChatEvent[][]) {}

  async *chat(req: ChatRequest, _signal: AbortSignal): AsyncIterable<ChatEvent> {
    this.requests.push(req);
    const turn = this.turns[this.index] ?? [{ type: "done", finishReason: "stop" }];
    this.index++;
    for (const ev of turn) yield ev;
  }
}
