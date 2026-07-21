/**
 * Processes a single SSE line. Lines that don't start with "data:" are skipped.
 * If the payload is "[DONE]", returns `done: true` to signal the stream has ended;
 * otherwise yields the payload (if present).
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
 * Parses an SSE (text/event-stream) body. Yields the payload of each
 * "data: <payload>" line; stops once "[DONE]" is seen. Lines split across
 * chunk boundaries are joined in the buffer. Lines that don't start with
 * "data:" are skipped. If the stream closes without a trailing newline on
 * the last line (defensive parsing — the SSE spec doesn't guarantee this),
 * the remaining line left in the buffer is processed too.
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
