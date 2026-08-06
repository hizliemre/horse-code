import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import { ToolRegistry } from "../tools/registry.js";
import { constitutionPath } from "../speckit/layout.js";
import {
  CLASSIFY_PROMPT, SCOPES, applyLabels, classifyMessage, parseConstitution, scopesForWork, selectRules,
  type Scope, type ScopedRule,
} from "./constitution.js";
import type { RoleAgentOptions } from "../agent/loop.js";
import type { RoleRegistry } from "../agent/roles.js";
import type { PermissionEngine } from "../permission/engine.js";
import type { Provider } from "../core/types.js";

const LabelsSchema = z.object({
  labels: z.array(z.object({ index: z.number().int(), scopes: z.array(z.enum(SCOPES)) })),
});

/** Enough to read a numbered list and answer with another one. It has no tools and nothing to explore. */
const CLASSIFY_MAX_TURNS = 3;

/**
 * Where the labelling is kept: horse-code's own home, keyed by the constitution's content.
 *
 * Not in the project. It is derived, and the project checkout is read and never written — the rule that
 * three separate leaks were traced to in one evening. Keyed by content so an amendment re-labels itself and
 * nothing else does; a machine that has never seen this constitution pays one call, once.
 */
function cachePath(home: string, text: string): string {
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  return join(home, ".horsecode", "constitution", `${hash}.json`);
}

/** In-process too: a wave of eight implementers must not read the same file eight times. */
const memo = new Map<string, ScopedRule[]>();

export interface ConstitutionDeps {
  provider: Provider;
  roleRegistry: RoleRegistry;
  permission: PermissionEngine;
  approve: RoleAgentOptions["approve"];
  signal: AbortSignal;
  home: string;
  note?: (text: string) => void;
}

/**
 * The project's rules, labelled — from cache when possible, from one model call when not.
 *
 * Never the reason anything fails: a constitution that cannot be labelled is handed over as `always`, which
 * costs a larger prompt and loses nothing. Silence is the one outcome that is not acceptable, because the
 * document says the rules are binding and everyone believes it.
 */
export async function scopedConstitution(deps: ConstitutionDeps, cwd: string): Promise<ScopedRule[]> {
  const path = constitutionPath(cwd);
  if (!existsSync(path)) return [];
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return []; }

  const cache = cachePath(deps.home, text);
  const hit = memo.get(cache);
  if (hit) return hit;
  if (existsSync(cache)) {
    try {
      const saved = JSON.parse(readFileSync(cache, "utf8")) as ScopedRule[];
      memo.set(cache, saved);
      return saved;
    } catch { /* unreadable cache → label it again */ }
  }

  const rules = parseConstitution(text);
  if (!rules.length) return [];
  let scoped: ScopedRule[];
  try {
    deps.note?.(`📜 Reading the project constitution — ${rules.length} rules, labelled once so each reaches `
      + `the work it binds.`);
    const resolved = deps.roleRegistry.resolve("analyst");
    const out = await runStructuredRole({
      provider: deps.provider, ...resolved, systemPrompt: CLASSIFY_PROMPT, tools: new ToolRegistry(),
      messages: [{ role: "user", content: classifyMessage(rules) }],
      permission: deps.permission, approve: deps.approve, cwd, signal: deps.signal,
      maxTurns: CLASSIFY_MAX_TURNS,
    }, LabelsSchema);
    scoped = applyLabels(rules, out.labels);
  } catch {
    // Unlabelled binds everyone: a rule delivered too widely is noise, one delivered to nobody is not a rule.
    scoped = rules.map((r) => ({ ...r, scopes: ["always" as Scope] }));
    deps.note?.(`⚠️ The constitution could not be labelled — every rule goes to every role this session.`);
  }
  try {
    mkdirSync(join(deps.home, ".horsecode", "constitution"), { recursive: true });
    writeFileSync(cache, JSON.stringify(scoped), "utf8");
  } catch { /* the cache is an optimisation, never a requirement */ }
  memo.set(cache, scoped);
  return scoped;
}

/** The constitution block for one piece of work — empty when the project has no constitution. */
export async function constitutionNote(
  deps: ConstitutionDeps, cwd: string, work: { role?: string; files?: string[]; title?: string },
): Promise<string> {
  const scoped = await scopedConstitution(deps, cwd);
  if (!scoped.length) return "";
  const sel = selectRules(scoped, scopesForWork(work));
  if (sel.dropped.length) {
    deps.note?.(`📜 ${sel.dropped.length} constitution section(s) that apply here did not fit the prompt: `
      + `${[...new Set(sel.dropped.map((d) => d.section))].join(", ")}.`);
  }
  return sel.text;
}
