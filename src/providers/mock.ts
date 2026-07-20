import type { ChatEvent, ChatRequest, Provider } from "../core/types.js";

/**
 * Test double: her chat() çağrısı için önceden yazılmış bir ChatEvent turn'ü yayar.
 * Çok-turlu loop'ları (tool-call → tool sonucu → ikinci turn) deterministik test eder.
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
