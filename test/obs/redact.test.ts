import { describe, it, expect } from "vitest";
import { redact, redactRecord, MASK } from "../../src/obs/redact.js";

/**
 * Found in a real telemetry file: `PGPASSWORD='…' psql -h localhost …`.
 *
 * An agent was handed a database password, put it on a command line, and the command line was recorded
 * verbatim — twenty lines across three files, in cleartext, in a directory whose whole purpose is to be read
 * later and shared when something needs explaining.
 */
describe("what never reaches the log", () => {
  it("blanks a password an agent put on a command line", () => {
    const out = redact("PGPASSWORD='caGC-uD)nMKC!1*FWbJY(7' psql -h localhost -p 5432 -U app");
    expect(out).not.toContain("caGC-uD");
    expect(out).toContain(MASK);
    expect(out).toContain("psql -h localhost");   // …the command is still readable
  });

  it("blanks anything whose NAME says what it is", () => {
    for (const line of [
      "API_KEY=abc123def456", "export AWS_SECRET_ACCESS_KEY=xyz", 'MY_TOKEN="t-0099"',
      "db_password: hunter2", "--token abc123def", "--password=s3cret",
    ]) {
      const out = redact(line);
      expect(out, line).toContain(MASK);
      expect(out, line).not.toMatch(/abc123def456|hunter2|s3cret|t-0099|xyz/);
    }
  });

  it("blanks a credential in a URL, and keeps the host", () => {
    const out = redact("git clone https://emre:pa55word@dev.azure.com/org/_git/repo");
    expect(out).not.toContain("pa55word");
    expect(out).toContain("dev.azure.com/org/_git/repo");
    expect(out).toContain("https://emre:");   // …who, and where, still say what happened
  });

  it("blanks a bearer token and the vendor key shapes", () => {
    expect(redact("Authorization: Bearer eyJhbGciOi.abc.def")).not.toContain("eyJhbGciOi");
    expect(redact("key sk-37d3edbe1d5d9beb08977")).not.toContain("sk-37d3edbe");
    expect(redact("ghp_ABCDEFGHIJKLMNOPQRSTUVWX")).toBe(MASK);
  });

  /**
   * Conservative on purpose: blanking real content to feel safe makes the log useless, and a useless log is
   * the one people turn off.
   */
  it("leaves ordinary text alone", () => {
    for (const line of [
      "read_file src/app.ts", "grep -n 'password' src/auth.ts", "npm test -- --watch=false",
      "git log --oneline -5", "the user asked about the password reset flow",
    ]) expect(redact(line), line).toBe(line);
  });

  it("reaches every string in a record, however deep", () => {
    const rec = { name: "tool.shell", attributes: { "hc.tool.subject": "PGPASSWORD=abc psql", "hc.duration_ms": 12 } };
    const out = redactRecord(rec);
    expect(out.attributes["hc.tool.subject"]).toContain(MASK);
    expect(out.attributes["hc.duration_ms"]).toBe(12);   // …numbers are not secrets, and cost nothing to keep
  });

  it("is applied by the sink itself, not by its callers", async () => {
    const src = await (await import("node:fs/promises")).readFile("src/obs/sink.ts", "utf8");
    expect(src).toContain("redactRecord(record)");
  });
});

/**
 * A password may contain any character; the shell's punctuation is not a promise about its contents.
 *
 * `)` was in the stop set for an unquoted value because it closes a subshell — and a real password closed the
 * mask instead. Found in a telemetry file written by this project:
 * `PGPASSWORD=«redacted»)nMKC!1*FWbJY(7` — the name said "secret", the redactor agreed, and then wrote
 * everything after the first bracket into the log verbatim.
 */
describe("a secret with brackets in it", () => {
  const PW = "caGC-uD)nMKC!1*FWbJY(7";

  it("masks the whole value, not the part before the first bracket", () => {
    const out = redact(`docker exec -e PGPASSWORD=${PW} postgres psql -U postgres`);
    expect(out).not.toContain(")nMKC");
    expect(out).not.toContain("FWbJY");
    expect(out).toContain(MASK);
  });

  it("leaves the rest of the command readable — the mask is the value, not the line", () => {
    const out = redact(`docker exec -e PGPASSWORD=${PW} postgres psql -U postgres`);
    expect(out).toContain("docker exec");
    expect(out).toContain("psql -U postgres");
  });

  it("does the same for a --password flag", () => {
    const out = redact(`mysql --password=${PW} -h db`);
    expect(out).not.toContain("FWbJY");
    expect(out).toContain("-h db");
  });

  it("still stops at a real command separator, so one secret does not eat the script", () => {
    const out = redact(`PGPASSWORD=${PW}; echo done`);
    expect(out).toContain("echo done");
    expect(out).not.toContain("FWbJY");
  });

  it("keeps masking quoted values whole, as before", () => {
    expect(redact(`PGPASSWORD='${PW}' psql`)).not.toContain("FWbJY");
    expect(redact(`PGPASSWORD="${PW}" psql`)).not.toContain("FWbJY");
  });
});
