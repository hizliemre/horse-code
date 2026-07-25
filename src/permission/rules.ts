import picomatch from "picomatch";

// Dangerous command patterns (rough, not fully comprehensive — extra safety in auto mode).
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b.*\s\/(\*|\s|$)/, // rm -rf / or /*
  /\brm\s+-rf\s+\/(\*|$)/,
  /:\(\)\s*\{.*\|.*&.*\}\s*;/, // fork bomb :(){ :|:& };:
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\/(sd|hd|nvme)/,
  /\b(sudo\s+)?chmod\s+-R\s+000\s+\//,
  /\s>\s*\/dev\/sd[a-z]/,
];

export function isDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some((re) => re.test(command));
}

// ── Read-only commands ────────────────────────────────────────────────────────────────────────────────────
// Inspecting the workspace is how an agent ORIENTS itself: `git status`, `grep`, `find`, `ls`. Gating those
// behind a prompt turns an autonomous run into a clicking exercise without buying any safety — they cannot
// change a single byte. Only commands proven read-only qualify; anything unrecognised falls through to the
// normal permission flow, so the list being incomplete costs a prompt, never safety.

/** Programs that cannot mutate anything, whatever arguments they are given. */
const READ_ONLY_BINS = new Set([
  "pwd", "ls", "cat", "head", "tail", "wc", "file", "stat", "du", "df", "tree", "find", "grep", "egrep",
  "fgrep", "rg", "ag", "echo", "printf", "sort", "uniq", "cut", "tr", "diff", "cmp", "basename", "dirname",
  "realpath", "readlink", "date", "whoami", "hostname", "uname", "which", "type", "env", "printenv", "true",
  "false", "seq", "yes", "column", "jq", "xxd", "od", "md5", "shasum", "sha256sum", "nl", "expr", "test",
]);

/** git subcommands that only read. Anything not listed (add/commit/push/reset/clean/…) is NOT read-only. */
const READ_ONLY_GIT = new Set([
  "status", "log", "diff", "show", "branch", "ls-tree", "ls-files", "rev-parse", "rev-list", "describe",
  "blame", "cat-file", "shortlog", "reflog", "tag", "remote", "worktree", "grep", "whatchanged", "count-objects",
]);

/** Commands whose FIRST TWO words decide it (a version/list query on an otherwise mutating tool). */
const READ_ONLY_PAIRS = new Set([
  "npm ls", "npm list", "npm view", "npm outdated", "pnpm ls", "pnpm list", "yarn list", "node --version",
  "npm --version", "python --version", "python3 --version", "go version", "cargo --version", "tsc --version",
]);

/** Argument shapes that make an otherwise read-only program write. */
const WRITE_FLAGS = /(^|\s)(-i|--in-place|-i\.\w+|--output|-o)(\s|=|$)/;
/** Any redirection or write-capable operator disqualifies the whole command. */
const REDIRECT = /(^|[^0-9<>])>{1,2}[^&]|(^|\s)(tee|dd|sudo|doas)(\s|$)/;

/**
 * Replaces the CONTENT of quoted spans with `x`, keeping length and the quotes themselves. Structural checks
 * then run on a string where `grep -E 'a|b'` no longer looks like a pipeline — the `|` in a regex argument is
 * data, not an operator. Returns undefined when quoting is unbalanced: unparseable means not provably safe.
 */
function maskQuoted(cmd: string): string | undefined {
  let out = "";
  let quote: string | undefined;
  for (const ch of cmd) {
    if (quote) {
      out += ch === quote ? ch : "x";
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    out += ch;
  }
  return quote ? undefined : out;
}

/** Splits on top-level `&&`, `||`, `|` and `;`, using the mask so operators inside quotes are not separators. */
function splitSegments(cmd: string, masked: string): string[] {
  const cuts: { at: number; len: number }[] = [];
  for (let i = 0; i < masked.length; i++) {
    const two = masked.slice(i, i + 2);
    if (two === "&&" || two === "||") { cuts.push({ at: i, len: 2 }); i++; continue; }
    if (masked[i] === "|" || masked[i] === ";") cuts.push({ at: i, len: 1 });
  }
  const out: string[] = [];
  let from = 0;
  for (const c of cuts) { out.push(cmd.slice(from, c.at)); from = c.at + c.len; }
  out.push(cmd.slice(from));
  return out;
}

/** Is this single, already-split command segment read-only? */
function segmentIsReadOnly(seg: string): boolean {
  const s = seg.trim();
  if (!s) return false;
  if (WRITE_FLAGS.test(s)) return false;
  const words = s.split(/\s+/);
  const bin = words[0].replace(/^.*\//, ""); // /usr/bin/grep → grep
  if (bin === "git") {
    const sub = words.slice(1).find((w) => !w.startsWith("-"));
    // `git worktree list` reads; `git worktree add` does not — a bare read-verb is not enough on its own.
    if (sub === "worktree") return words.includes("list");
    if (sub === "remote") return words.length === 2 || words.includes("-v") || words.includes("show");
    if (sub === "tag") return words.includes("-l") || words.includes("--list") || words.length === 2;
    return sub !== undefined && READ_ONLY_GIT.has(sub);
  }
  if (bin === "sed") return words.includes("-n"); // `sed -i` edits in place; only the print-only form reads
  if (bin === "awk") return true; // awk CAN write via > , but the redirect guard already rejected that
  if (READ_ONLY_PAIRS.has(`${bin} ${words[1] ?? ""}`)) return true;
  return READ_ONLY_BINS.has(bin);
}

/**
 * True when a command provably only READS. Conservative by construction: every segment must be recognised,
 * substitution/redirection/in-place flags disqualify the whole command, and anything unknown returns false —
 * so an incomplete list costs a prompt, never safety.
 */
export function isReadOnly(command: string): boolean {
  const c = command.trim();
  if (!c) return false;
  const masked = maskQuoted(c);
  if (masked === undefined) return false; // unbalanced quotes → not provably anything
  // Substitution can hide any command inside an innocent-looking one: $(…), `…`, ${…}, <(…).
  if (/\$\(|`|\$\{|<\(/.test(masked)) return false;
  if (REDIRECT.test(masked)) return false;
  const segments = splitSegments(c, masked);
  return segments.length > 0 && segments.every(segmentIsReadOnly);
}

// Shell chaining/injection metacharacters: a command containing these
// cannot be SAFELY matched against a prefix-allowlist (e.g. "npm test && rm -rf ~").
const SHELL_METACHARACTERS = /[;&|`\n<>${}()]/;

/**
 * Does allowKey match a rule?
 * @param kind "glob" → file path matching (picomatch); "prefix" → shell command prefix matching.
 * The match kind is explicitly provided by the caller (engine) based on `PermissionLevel` —
 * it is not guessed from the string's shape.
 */
export function matchesAllowlist(
  allowKey: string,
  rules: string[],
  kind: "glob" | "prefix",
): boolean {
  // In prefix mode, a command containing metacharacters cannot safely match any rule.
  if (kind === "prefix" && SHELL_METACHARACTERS.test(allowKey)) return false;

  for (const rule of rules) {
    if (kind === "glob") {
      if (picomatch(rule)(allowKey)) return true;
    } else {
      if (allowKey === rule || allowKey.startsWith(rule + " ")) return true;
    }
  }
  return false;
}
