import type { CliKind } from "./cli-agent.js";

/**
 * What the CLIs can be asked for — families, not versions, and no source prefix.
 *
 * The gateway needed both. A prefix said which subscription to route through, and a version said exactly
 * which build, because its catalog of 726 listed every one and lied about which it would serve. Neither
 * survives the move: a CLI IS its subscription, and it resolves a family name to its own current best.
 *
 * Measured, and it is the whole argument for naming families: `fable` served `claude-fable-5-1` — the very
 * model that returned 404 through the gateway, which resolved `claude-fable-5` to a name that did not exist
 * ("model: claude-fable-5.1 was not found. Did you mean claude-fable-5-1?"). A version name is a claim about
 * the world that ages; an alias is a question the CLI answers freshly every time.
 *
 * So the list holds no dates and no version numbers, and it cannot go stale the way the previous one could.
 * What it can still miss is a whole new family, which is a line to add rather than a silent wrong answer.
 */

/**
 * Claude Code's families. Each was asked for and answered by a model of that family, which is the only
 * check worth running here: the CLI does not validate `--model`, and an unknown name returns a
 * `<synthetic>` answer rather than an error.
 *
 *   fable  → claude-fable-5-1      opus   → claude-opus-5
 *   sonnet → claude-sonnet-5       haiku  → claude-haiku-4-5-20251001
 */
export const CLAUDE_MODELS = ["fable", "opus", "sonnet", "haiku"] as const;

/**
 * Codex's models. These are TIERS rather than versions — terra, sol and luna name sizes of the same
 * generation, so dropping them would leave one model and nothing for the band logic to spread a chain
 * across. `gpt-5.5` is the one genuine version here, and it goes.
 *
 * `codex` is the CLI's own default, invoked by passing no model at all: the closest thing it has to an
 * alias, and current by construction. Its own alias scheme, if it has one, is not documented and the probe
 * that would have settled it did not return in time — so this is stated as what was verified, not as the
 * whole truth.
 */
export const CODEX_MODELS = ["codex", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"] as const;

/** The whole assignable catalog. `adjustRoleModels` does its own ranking, so this order decides nothing. */
export function cliCatalog(): string[] {
  return [...CLAUDE_MODELS, ...CODEX_MODELS];
}

/**
 * Which CLI serves a model, read from the name itself now that nothing carries a prefix.
 *
 * A prefix was the gateway's way of saying which subscription to bill; with one binary per family the name
 * already says it. Anything unrecognised returns undefined rather than a guess — a role pointing at a model
 * nothing serves must fail loudly, because served quietly by a default the answer would be attributed to a
 * model that never ran.
 */
export function cliFor(model: string): CliKind | undefined {
  const m = model.toLowerCase().replace(/^no-think\//, "").replace(/^(cc|claude|cx|codex)\//, "");
  if (/^(fable|opus|sonnet|haiku)\b/.test(m) || m.startsWith("claude")) return "claude";
  if (/^(codex|gpt|o[0-9])\b/.test(m)) return "codex";
  return undefined;
}

/**
 * The name to pass the CLI, and the effort to pass beside it.
 *
 * `opus-high` is one horse-code id meaning two things: a family and how hard to work. The CLIs take them
 * separately — Claude as `--effort`, Codex not at all — so they are split here rather than at each call site.
 * `codex` means the CLI's default, which is expressed by passing no model at all.
 */
export function cliInvocation(model: string): { model?: string; effort?: string } {
  const bare = model.replace(/^no-think\//, "").replace(/^(cc|claude|cx|codex)\//, "");
  const effort = /-(ultra|max|xhigh|high|medium|low|minimal)$/.exec(bare)?.[1];
  const name = effort ? bare.slice(0, -(effort.length + 1)) : bare;
  return {
    ...(name && name !== "codex" ? { model: name } : {}),
    ...(effort ? { effort } : {}),
  };
}
