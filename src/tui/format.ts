/** Compact token count that rolls over units: 900 → "900", 1234 → "1.2k", 21_914_000 → "21.9M", 3.2e9 → "3.2B". */
export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Duration like Claude Code: "1m 23s" from a minute up, else "45s". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Relative time from a past epoch-ms to now: "just now", "5m ago", "3h ago", "2d ago". */
export function relTime(then: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Removes a model's own thinking from text meant for a person.
 *
 * Some models emit `<think>…</think>` in the ordinary text stream. It is not an answer and it was never
 * meant to be read: a by-the-way reply came back on screen as `</think>Şu an 65 görev merge edildi…`, with
 * the closing tag in front of the sentence because the opening one had streamed past earlier.
 *
 * Written for STREAMING text, which is why an unclosed `<think>` swallows the rest: mid-stream, everything
 * after the tag really is thinking, and showing it and then retracting it is worse than waiting. A lone
 * closing tag — the case above, where the run began before this function saw it — drops everything up to
 * and including itself.
 */
export function stripThinking(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const lastClose = out.toLowerCase().lastIndexOf("</think>");
  if (lastClose !== -1 && !/<think>/i.test(out.slice(0, lastClose))) {
    out = out.slice(lastClose + "</think>".length);
  }
  const open = out.toLowerCase().lastIndexOf("<think>");
  if (open !== -1) out = out.slice(0, open).trimEnd(); // no dangling space where the tag was
  return out.trimStart();
}
