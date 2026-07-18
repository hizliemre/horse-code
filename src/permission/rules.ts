import picomatch from "picomatch";

// Tehlikeli komut desenleri (kaba, tam kapsayıcı değil — auto modda ek güvenlik).
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b.*\s\/(\*|\s|$)/, // rm -rf / veya /*
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

/**
 * allowKey bir kurala uyuyor mu?
 * - Glob görünümlü kurallar (`*`, `?`, `[`, `/` içeren) picomatch ile eşleştirilir (dosya yolları).
 * - Diğerleri prefix eşleşmesi (shell komutları: "npm test" → "npm test --watch").
 */
export function matchesAllowlist(allowKey: string, rules: string[]): boolean {
  for (const rule of rules) {
    const looksGlob = /[*?\[\]]/.test(rule) || rule.includes("/");
    if (looksGlob) {
      if (picomatch(rule)(allowKey)) return true;
    } else {
      if (allowKey === rule || allowKey.startsWith(rule + " ")) return true;
    }
  }
  return false;
}
