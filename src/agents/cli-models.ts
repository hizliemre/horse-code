import { cliFor } from "./cli-provider.js";

/**
 * What the CLIs can actually be asked for.
 *
 * The gateway answered this with a live catalog of 726 models, and most of the fleet machinery exists
 * because that list was untrustworthy: listed and routable were different things, so a model had to be
 * probed, benched, and re-probed to find out which it was. A CLI has no such gap. It serves a small set it
 * either knows or rejects outright, so the catalog is declared rather than discovered — and every mechanism
 * built to survive a lying catalog simply has less to do.
 *
 * The prefixes are the ones the role registry already uses. `cc/` was always Claude and `cx/` always Codex,
 * so a config of sixty-four tuned chains keeps working; renaming every model in it would have been the only
 * alternative. `antigravity/` was a gateway source with no binary behind it and is gone.
 *
 * Declared, therefore stale-able: a model released after this list is written is invisible until the list is
 * updated. That is the trade for never again handing a role a name the fleet cannot serve, which cost one
 * run 118 of its 125 tasks.
 */

/**
 * Claude Code's models, newest first within each band. Effort travels as a flag, not in the name.
 *
 * Every one of these was asked for and answered by a model of that name — the check that matters, because
 * the CLI does not validate `--model` and an unknown name returns a `<synthetic>` answer instead of an
 * error. `claude-haiku-4-5` resolves to the dated build, which is why the bare form is listed: it is the
 * name that keeps working when the date moves.
 */
export const CLAUDE_MODELS = [
  "cc/claude-fable-5",
  "cc/claude-opus-5",
  "cc/claude-opus-4-8",
  "cc/claude-sonnet-5",
  "cc/claude-sonnet-4-6",
  "cc/claude-haiku-4-5",
] as const;

/**
 * The CLI's own aliases, which always name its current best of that family.
 *
 * Verified to resolve rather than assumed: `opus` served `claude-opus-5`, and an alias that stops being
 * recognised would answer `<synthetic>` rather than fail, so these are worth re-checking when a family
 * moves. They earn their place by not going stale — the list above names versions, and versions age.
 */
export const CLAUDE_ALIASES = [
  "cc/opus",
  "cc/sonnet",
  "cc/haiku",
] as const;

/** Codex's models. The level IS the name here, which is why these read differently from the Claude ids. */
export const CODEX_MODELS = [
  "cx/gpt-5.6-terra",
  "cx/gpt-5.6-sol",
  "cx/gpt-5.6-luna",
  "cx/gpt-5.5",
] as const;

/**
 * The whole assignable catalog.
 *
 * Ordered Claude-first only because that is how the bands read; `adjustRoleModels` does its own ranking and
 * spreads chains across sources, so this order decides nothing on its own.
 */
export function cliCatalog(): string[] {
  return [...CLAUDE_MODELS, ...CLAUDE_ALIASES, ...CODEX_MODELS];
}

/**
 * The models from a role's configured chain that a CLI can still serve.
 *
 * A chain written against the gateway may name sources that no longer exist. Rather than silently dropping
 * a role to its default, this says exactly which of its links survive, so a caller can report the ones that
 * do not instead of discovering them one failed call at a time.
 */
export function servableModels(configured: string[]): { servable: string[]; orphaned: string[] } {
  const servable: string[] = [];
  const orphaned: string[] = [];
  for (const m of configured) (cliFor(m) ? servable : orphaned).push(m);
  return { servable, orphaned };
}
