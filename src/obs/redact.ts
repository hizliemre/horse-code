/**
 * Secrets never reach the log, however they arrived.
 *
 * Found in a real telemetry file: `PGPASSWORD='…' psql -h localhost …` — an agent had been handed a database
 * password by the user, put it on a command line, and the command line was recorded verbatim. Twenty lines
 * across three files, in cleartext, in a directory whose whole purpose is to be read later and shared when
 * something needs explaining.
 *
 * Redacting at the SINK rather than at each call site, because there is one sink and there are dozens of
 * places that write to it — and the one that gets missed is the one that carries the secret.
 *
 * The rule is conservative on purpose: only shapes that are unambiguous. A value that merely looks random is
 * left alone, because blanking real content to feel safe makes the log useless and teaches people to turn it
 * off. What is caught is what people actually leak: an assignment whose NAME says secret, a credential in a
 * URL, a bearer token, and the vendor key formats that are recognisable on sight.
 */

/** What replaces a secret. Recognisable, so a reader knows something was there. */
export const MASK = "«redacted»";

/** `PGPASSWORD=…`, `API_KEY=…`, `--token …`: the name says what it is, so the value goes. */
// The name may BEGIN with the word — `API_KEY=…` — so the prefix has to be optional, not one character.
const NAMED = /\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|PASS|SECRET|TOKEN|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)[A-Za-z0-9_]*)\s*[=:]\s*(?:"([^"]*)"|'([^']*)'|([^\s;&|)]+))/gi;
const FLAGGED = /(--(?:password|token|secret|api-key|apikey|access-key)(?:[=\s]+))(?:"([^"]*)"|'([^']*)'|([^\s;&|)]+))/gi;
/** `proto://user:pass@host` — the password half only; the user and the host still say what was reached. */
const IN_URL = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]+)@/gi;
const BEARER = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{8,})/g;
/** Vendor formats that are recognisable on sight, and are always secret when they appear. */
const VENDOR = /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,})\b/g;

export function redact(text: string): string {
  return text
    .replace(NAMED, (_m, name: string) => `${name}=${MASK}`)
    .replace(FLAGGED, (_m, flag: string) => `${flag}${MASK}`)
    .replace(IN_URL, (_m, head: string) => `${head}:${MASK}@`)
    .replace(BEARER, (_m, scheme: string) => `${scheme} ${MASK}`)
    .replace(VENDOR, MASK);
}

/**
 * Every string in a record, redacted — including nested attributes.
 *
 * Numbers, durations and counts are left as they are: a secret is a string, and rewriting the rest would
 * cost something on every record for nothing.
 */
export function redactRecord<T>(record: T): T {
  if (typeof record === "string") return redact(record) as unknown as T;
  if (Array.isArray(record)) return record.map((v) => redactRecord(v)) as unknown as T;
  if (record && typeof record === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record as Record<string, unknown>)) out[k] = redactRecord(v);
    return out as unknown as T;
  }
  return record;
}
