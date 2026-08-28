/**
 * What actually went wrong on the wire, instead of the word `fetch`.
 *
 * Node's `fetch` throws a `TypeError` whose message is the constant string "fetch failed" and puts every
 * useful fact — the syscall, the address, the port — on `cause`. We printed the message. Measured on a live
 * project: `/graph trace` attempted 348 files, every one failed, and the report was 348 lines reading
 * "— fetch failed" plus "Project brief failed (fetch failed)". The gateway on `localhost:20128` was simply
 * not running, and the answer was one `ECONNREFUSED` deep, in a field nobody read.
 *
 * The cause chain nests: `AggregateError` when several addresses were tried (IPv6 then IPv4 is the ordinary
 * case for `localhost`), and a plain system error under it. Both are walked.
 */

/** Node system-error codes worth saying in words. Anything else is reported by its code, which is still a fact. */
const SAYS: Record<string, (where: string) => string> = {
  ECONNREFUSED: (w) => `nothing is listening at ${w} — connection refused`,
  ENOTFOUND: (w) => `${w} could not be resolved — no such host`,
  EAI_AGAIN: (w) => `${w} could not be resolved right now — DNS is not answering`,
  ECONNRESET: (w) => `${w} closed the connection`,
  EPIPE: (w) => `${w} closed the connection while it was being written to`,
  ETIMEDOUT: (w) => `${w} did not accept a connection in time`,
  EHOSTUNREACH: (w) => `${w} is unreachable from this machine`,
  ENETUNREACH: (w) => `${w} is unreachable — no route`,
  CERT_HAS_EXPIRED: (w) => `${w} presented an expired TLS certificate`,
  DEPTH_ZERO_SELF_SIGNED_CERT: (w) => `${w} presented a self-signed TLS certificate`,
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: (w) => `${w} presented a certificate that could not be verified`,
};

/** The first `code` in the cause chain, breadth-first through any `AggregateError`. */
export function causeCode(e: unknown): string | undefined {
  const queue: unknown[] = [e];
  for (let i = 0; i < queue.length && i < 32; i++) {
    const cur = queue[i];
    if (typeof cur !== "object" || cur === null) continue;
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
    const errors = (cur as { errors?: unknown }).errors;
    if (Array.isArray(errors)) queue.push(...errors);
    const cause = (cur as { cause?: unknown }).cause;
    if (cause !== undefined) queue.push(cause);
  }
  return undefined;
}

/** `http://host:port` — the part that decides whether a connection is possible. The path never does. */
export function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * The message a person can act on.
 *
 * Keeps the code in parentheses even when it has been said in words: it is what a search engine and a log
 * filter both key on, and dropping it to read better would cost more than it buys.
 */
export function transportMessage(e: unknown, url: string): string {
  const said = e instanceof Error ? e.message : String(e);
  const code = causeCode(e);
  if (code === undefined) return said;
  const where = origin(url);
  const say = SAYS[code];
  return say ? `${say(where)} (${code})` : `${where} could not be reached (${code})`;
}
