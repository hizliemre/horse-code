import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The version from the manifest that shipped this file, not a constant someone has to remember to bump.
 *
 * `import.meta.url` points at the built bundle under `dist/` when installed and at `src/` in a checkout;
 * the manifest is one level up from both. A version nobody can read is the first thing an installed CLI is
 * asked for — `hcode --version` is what a bug report quotes — so a failure to find it says so rather than
 * inventing a number.
 */
export function hcodeVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Every flag `parseArgs` understands, in the order the help prints them. One list, two readers. */
export const FLAGS = [
  "--branch", "-b", "--job", "-j", "--rounds", "--revision-rounds", "--no-tui",
  "--help", "-h", "--version", "-v",
] as const;

export function usage(): string {
  return [
    `horse-code ${hcodeVersion()} — a terminal coding agent that works on its own branch.`,
    "",
    "USAGE",
    "  hcode                      start the REPL",
    "  hcode \"<request>\"          run one request to completion, then report where the work landed",
    "  hcode init                 write .horsecode/ for this project and ask for the essentials",
    "",
    "OPTIONS",
    "  -b, --branch <name>        branch the session's worktree from this ref (default: current branch)",
    "  -j, --job <name>           name the session, and the branch it creates",
    "      --rounds <n>           review rounds per document stage",
    "      --revision-rounds <n>  revision rounds per implementation task",
    "      --no-tui               plain output, no terminal UI — for pipes, CI and logs",
    "  -h, --help                 this",
    "  -v, --version              print the version and exit",
    "",
    "Configuration is ~/.horsecode/config.json, overlaid by .horsecode/config.json in the project.",
    "Run `hcode init` if you have neither.",
  ].join("\n");
}

/**
 * Says what an unrecognised flag is, instead of silently running it as the request.
 *
 * Unknown arguments fell through to the prompt, so `hcode --version` started a session whose task was the
 * literal text "--version" — it opened a worktree, called a model, and failed on a network error. A typo in
 * a flag has the same shape and the same cost: the flag becomes the work.
 */
export function nearestFlag(flag: string): string | undefined {
  const score = (a: string): number => {
    const b = flag;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };
  const best = [...FLAGS].filter((f) => f.startsWith("--") === flag.startsWith("--"))
    .sort((a, b) => score(b) - score(a))[0];
  return best !== undefined && score(best) > 2 ? best : undefined;
}
