/**
 * Tek bir SSE satırını işler. "data:" ile başlamayan satırlar atlanır.
 * Payload "[DONE]" ise stream'in bittiğini bildirmek için `done: true` döner;
 * aksi halde (varsa) payload'u yield eder.
 */
function* handleLine(line: string): Generator<string, boolean> {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return false;
  const payload = trimmed.slice(5).trim();
  if (payload === "[DONE]") return true;
  if (payload) yield payload;
  return false;
}

/**
 * SSE gövdesini (text/event-stream) ayrıştırır. Her "data: <payload>" satırının
 * payload'unu yield eder; "[DONE]" görülünce durur. Chunk sınırlarında bölünen
 * satırlar buffer'da birleştirilir. "data:" ile başlamayan satırlar atlanır.
 * Stream, sondaki satırda newline olmadan kapanırsa (defansif ayrıştırma —
 * SSE spesifikasyonu bunu garanti etmez), buffer'da kalan son satır da işlenir.
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
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const isDone = yield* handleLine(line);
        if (isDone) return;
      }
    }
    if (buffer) {
      yield* handleLine(buffer);
    }
  } finally {
    reader.releaseLock();
  }
}
