/**
 * SSE gövdesini (text/event-stream) ayrıştırır. Her "data: <payload>" satırının
 * payload'unu yield eder; "[DONE]" görülünce durur. Chunk sınırlarında bölünen
 * satırlar buffer'da birleştirilir. "data:" ile başlamayan satırlar atlanır.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        if (payload) yield payload;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
