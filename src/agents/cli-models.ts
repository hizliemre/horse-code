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
 * Codex's models. Every one of these was asked for and answered.
 *
 * These are TIERS rather than versions — terra, sol and luna name sizes of the same generation, so dropping
 * them would leave nothing for the band logic to spread a chain across. Worth stating plainly: the
 * capability scorer gives all three the same number, so nothing here ranks them; they are three names that
 * work, and which suits a role is a question only a run can answer.
 *
 * `codex` used to sit at the head of this list, meaning "pass no `--model` at all and take the CLI's
 * default". It is gone, and it should never have been here: it is not a model. It named nothing, so 27 calls
 * on a live board were recorded against an id that does not exist, and the Codex stream does not report what
 * served — `codex doctor` itself only says `model <default> · openai`. It also occupied a chain slot
 * indistinguishable from its own resolution, so a chain could hold the same model twice with the second
 * copy as dead fallback weight.
 *
 * Measured while removing it: an unknown name is REFUSED by Codex with an error, which is the opposite of
 * Claude Code, where a bogus `--model` answers anyway and reports `<synthetic>`. So on this side a wrong
 * name fails honestly, and no `<synthetic>`-style guard is needed for it.
 */
export const CODEX_MODELS = ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"] as const;

/**
 * What a chain written before `codex` was removed should run instead.
 *
 * 32 role chains named it. Left alone each would spend an attempt being refused before sliding on, once per
 * call, so it resolves to a real name here instead. `gpt-5.6-terra` is not a judgement — the scorer rates
 * all three tiers identically — it is the least surprising substitution, being the one those chains already
 * led with and the one that served most of the last run. `/roles adjust` replaces it with a real assignment.
 */
const CODEX_DEFAULT = "gpt-5.6-terra";

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
  // Always a name. Passing no `--model` ran whatever the CLI felt like and reported it as a model called
  // `codex`, which is not one — see CODEX_MODELS. A bare `codex` from an older chain resolves instead.
  const resolved = name === "codex" ? CODEX_DEFAULT : name;
  return {
    ...(resolved ? { model: resolved } : {}),
    ...(effort ? { effort } : {}),
  };
}
