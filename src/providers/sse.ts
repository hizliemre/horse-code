/** A parsed SSE line: a `data:` payload, or a `:` comment (omniroute ships real token counts as comments). */
export interface SSELine {
  kind: "data" | "comment";
  value: string;
}

/**
 * Processes a single SSE line.
 * - "data: <payload>" → yields { kind: "data", value: payload }; "[DONE]" ends the stream (returns true).
 * - ": <comment>" → yields { kind: "comment", value: comment } (omniroute appends real usage as comments).
 * - anything else (blank lines, event:/id: fields) → skipped.
 */
function* handleLine(line: string): Generator<SSELine, boolean> {
  const trimmed = line.trim();
  if (trimmed.startsWith("data:")) {
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") return true;
    if (payload) yield { kind: "data", value: payload };
    return false;
  }
  if (trimmed.startsWith(":")) {
    const value = trimmed.slice(1).trim();
    if (value) yield { kind: "comment", value };
  }
  return false;
}

/**
 * Parses an SSE (text/event-stream) body. Yields a typed line for each "data:" payload and ":" comment;
 * stops once "[DONE]" is seen. Lines split across chunk boundaries are joined in the buffer. If the stream
 * closes without a trailing newline on the last line (defensive — the SSE spec doesn't guarantee this),
 * the remaining line left in the buffer is processed too.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<SSELine> {
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
