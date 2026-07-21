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
