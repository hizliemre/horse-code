import { describe, it, expect } from "vitest";
import { transportMessage, causeCode, origin } from "../../src/providers/transport.js";
import { describeTraceFailures } from "../../src/cli.js";

/** What Node actually throws: a constant message, and the fact one or two levels down on `cause`. */
const fetchFailure = (code: string, aggregate = false): Error => {
  const sys = Object.assign(new Error(`connect ${code} 127.0.0.1:20128`), { code });
  const inner = aggregate ? Object.assign(new AggregateError([sys], "")) : sys;
  return Object.assign(new TypeError("fetch failed"), { cause: inner });
};

/**
 * 348 lines reading "fetch failed", and the answer one field away.
 *
 * Measured on a live project: `/graph trace` attempted 348 files, every one failed, and the report said
 * nothing but the word "fetch" — 348 times, plus once more for the project brief. The gateway on
 * `localhost:20128` was not running. `ECONNREFUSED` was on `cause` the entire time.
 */
describe("what went wrong on the wire", () => {
  it("says a refused connection in words, and keeps the code", () => {
    const text = transportMessage(fetchFailure("ECONNREFUSED"), "http://localhost:20128");
    expect(text).toContain("nothing is listening at http://localhost:20128");
    expect(text).toContain("ECONNREFUSED");
    expect(text).not.toBe("fetch failed");
  });

  /**
   * `localhost` resolves to both ::1 and 127.0.0.1, so Node tries both and reports an AggregateError. The
   * ordinary local case is therefore the nested one — a walk that stopped at the first `cause` would have
   * found nothing precisely when it was needed most.
   */
  it("finds the code inside an AggregateError of attempted addresses", () => {
    expect(causeCode(fetchFailure("ECONNREFUSED", true))).toBe("ECONNREFUSED");
    expect(transportMessage(fetchFailure("ECONNREFUSED", true), "http://localhost:20128"))
      .toContain("connection refused");
  });

  it("distinguishes the failures that need different fixes", () => {
    const at = (code: string) => transportMessage(fetchFailure(code), "https://api.example.com/v1");
    expect(at("ENOTFOUND")).toContain("no such host");
    expect(at("ECONNRESET")).toContain("closed the connection");
    expect(at("ETIMEDOUT")).toContain("did not accept a connection in time");
    expect(at("CERT_HAS_EXPIRED")).toContain("expired TLS certificate");
  });

  /** A code nobody anticipated is still a fact, and better than the word "fetch". */
  it("reports an unmapped code rather than falling back to the useless message", () => {
    const text = transportMessage(fetchFailure("UND_ERR_SOCKET"), "http://localhost:20128");
    expect(text).toContain("UND_ERR_SOCKET");
    expect(text).toContain("http://localhost:20128");
  });

  it("keeps the original message when there is no cause to read", () => {
    expect(transportMessage(new Error("model refused the request"), "http://x")).toBe("model refused the request");
  });

  /** Whether a connection is possible is decided by host and port; the path never enters into it. */
  it("names the origin, not the endpoint that happened to be called", () => {
    expect(origin("http://localhost:20128/api/v1/chat/completions")).toBe("http://localhost:20128");
    expect(origin("not a url")).toBe("not a url");
  });
});

describe("reporting many failures that share one cause", () => {
  const many = (n: number, error: string) =>
    Array.from({ length: n }, (_, i) => ({ file: `src/File${i}.cs`, error }));

  it("states the cause once and uses the files as examples", () => {
    const text = describeTraceFailures(many(348, "nothing is listening at http://localhost:20128 (ECONNREFUSED)"));
    expect(text).toContain("348 failed, all for the same reason");
    expect(text).toContain("ECONNREFUSED");
    expect(text).toContain("…and 345 more");
    // The reason appears once, not once per file.
    expect(text.match(/ECONNREFUSED/g)).toHaveLength(1);
  });

  it("lists distinct causes commonest first, because there the paths do carry signal", () => {
    const text = describeTraceFailures([...many(3, "connection refused"), ...many(1, "context too long")]);
    expect(text).toContain("3× connection refused");
    expect(text).toContain("1× context too long");
    expect(text.indexOf("3×")).toBeLessThan(text.indexOf("1×"));
  });

  it("says nothing at all when nothing failed", () => {
    expect(describeTraceFailures([])).toBe("");
  });
});
