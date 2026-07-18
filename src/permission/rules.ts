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

// Shell zincirleme/injection metakarakterleri: bunları içeren bir komut
// prefix-allowlist ile GÜVENLE eşleştirilemez (örn "npm test && rm -rf ~").
const SHELL_METACHARACTERS = /[;&|`\n<>${}()]/;

/**
 * allowKey bir kurala uyuyor mu?
 * @param kind "glob" → dosya yolu eşleştirmesi (picomatch); "prefix" → shell komutu prefix eşleşmesi.
 * Eşleşme türü çağıran (engine) tarafından `PermissionLevel`'e göre açıkça verilir — string
 * şeklinden tahmin edilmez.
 */
export function matchesAllowlist(
  allowKey: string,
  rules: string[],
  kind: "glob" | "prefix",
): boolean {
  // Prefix modunda metakarakter içeren komut hiçbir kurala güvenle eşleşemez.
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
