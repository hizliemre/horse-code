import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runStructuredRole } from "../agent/structured.js";
import { ToolRegistry } from "../tools/registry.js";
import { constitutionPath } from "../speckit/layout.js";
import {
  CLASSIFY_BATCH, CLASSIFY_PROMPT, SCOPES, applyLabels, classifyMessage, parseConstitution, scopesForWork, selectRules,
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
  deps.note?.(`📜 Reading the project constitution — ${rules.length} rules, labelled once so each reaches `
    + `the work it binds.`);
  /**
   * In batches, because one answer for all of them was not one answer.
   *
   * Measured on the first run: seventy rules in a single call came back at 437 output tokens — about half a
   * list — so everything the model never reached defaulted to `always`, and the whole constitution ended up
   * bound to every role. That looked identical to a document that genuinely binds everyone.
   */
  const labels: { index: number; scopes: string[] }[] = [];
  const resolved = deps.roleRegistry.resolve("analyst");
  for (let start = 0; start < rules.length; start += CLASSIFY_BATCH) {
    const batch = rules.slice(start, start + CLASSIFY_BATCH);
    try {
      const out = await runStructuredRole({
        provider: deps.provider, ...resolved, systemPrompt: CLASSIFY_PROMPT, tools: new ToolRegistry(),
        messages: [{ role: "user", content: classifyMessage(batch, start) }],
        permission: deps.permission, approve: deps.approve, cwd, signal: deps.signal,
        maxTurns: CLASSIFY_MAX_TURNS,
      }, LabelsSchema);
      labels.push(...out.labels);
    } catch { /* this batch binds everyone; the next one may still answer */ }
  }
  const { scoped, unlabelled } = applyLabels(rules, labels);
  if (unlabelled.length) {
    deps.note?.(`⚠️ ${unlabelled.length} of ${rules.length} constitution rules could not be labelled — those `
      + `go to every role. A rule sent too widely is noise; one sent nowhere is not a rule.`);
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
