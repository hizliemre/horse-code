import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Provider } from "../core/types.js";
import type { MemoryStore } from "../session/memory.js";
import { discover, summarize, hasAnything } from "./discover.js";
import type { Finding } from "./discover.js";
import { extractAll, groupForReview, consolidateRules, MAX_RULES } from "./extract.js";
import type { Candidate } from "./extract.js";

/**
 * The migration conversation.
 *
 * Structured as a few decisions rather than many: a real project had 218 remembered facts and 62 skills, and
 * asking about each would be a worse experience than losing them. So the user is asked per GROUP, shown a
 * sample of what is in it, and told exactly what will happen — including what is being left behind and why.
 *
 * Nothing is written until the answer for that group arrives. A migration that half-applied and then stopped
 * would leave a memory nobody can audit.
 */

export type Ask = (question: string, opts?: { options?: { label: string; description?: string }[] }) => Promise<string>;
export type Note = (text: string) => void;

export interface MigrateDeps {
  cwd: string;
  home: string;
  provider: Provider;
  model: string;
  memStore: MemoryStore;
  ask: Ask;
  note: Note;
  signal?: AbortSignal;
}

export interface MigrateResult {
  rules: number;
  facts: number;
  skills: number;
  skipped: number;
  /** Groups the user declined, so the report is about what happened rather than what was offered. */
  declined: string[];
}

const YES = /^(yes|import|copy|evet)/i;

/** Entries of one kind currently in the store — the basis for reporting what actually landed. */
function countKind(store: MemoryStore, kind: "rule" | "fact"): number {
  return store.all().filter((m) => (m.kind ?? "fact") === kind).length;
}

/** Up to this many examples are shown per group; enough to judge the batch, short enough to read. */
const SAMPLE = 6;

function sample(items: Candidate[]): string {
  return items.slice(0, SAMPLE).map((c) => `- ${c.text}`).join("\n")
    + (items.length > SAMPLE ? `\n- _…and ${items.length - SAMPLE} more_` : "");
}

/**
 * Runs the whole migration.
 *
 * Returns what was actually imported. Every step is skippable and every skip is reported: the point of the
 * exercise is that the user knows what their new setup contains, and a silent import defeats it as surely as
 * a silent omission.
 */
export async function runMigration(deps: MigrateDeps): Promise<MigrateResult> {
  const result: MigrateResult = { rules: 0, facts: 0, skills: 0, skipped: 0, declined: [] };
  const findings = await discover({ cwd: deps.cwd, home: deps.home });

  if (!hasAnything(findings)) {
    deps.note("No configuration from another coding tool was found here — nothing to migrate.");
    return result;
  }
  deps.note(`**Found in this project:**\n${summarize(findings)}`);

  // --- instructions and memory ------------------------------------------------------------------------
  const prose = findings.filter((f) => (f.kind === "rules" || f.kind === "memory") && f.text);
  if (prose.length) {
    deps.note(`Reading ${prose.length} file(s) to work out which instructions still apply here. ` +
      `_This is the part that costs tokens; nothing is imported until you say so._`);
    const extraction = await extractAll({
      provider: deps.provider, model: deps.model, findings: prose,
      ...(deps.signal ? { signal: deps.signal } : {}),
      onProgress: (done, total) => { if (done === total) deps.note(`Read ${total}/${total}.`); },
    });
    if (extraction.failed.length) {
      deps.note(`⚠️ ${extraction.failed.length} could not be read: ` +
        extraction.failed.slice(0, 3).map((f) => `\`${f.source}\``).join(", "));
    }
    const raw = groupForReview(extraction);
    result.skipped = raw.skipped.length;

    /**
     * Consolidation, before the user is asked anything.
     *
     * A real 53 KB instruction document yielded 168 rule candidates. Asking "import 168 rules?" is not a
     * real question — nobody can evaluate it, and yes would put roughly 15 KB into every prompt forever.
     * The pile is reduced first, so the question is about a list the user can actually read.
     */
    let rules = raw.rules;
    const facts = [...raw.facts];
    if (rules.length > MAX_RULES) {
      deps.note(`${rules.length} rule candidates — consolidating, since every rule is inlined into every prompt forever.`);
      const c = await consolidateRules({
        provider: deps.provider, model: deps.model, candidates: rules,
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
      if (c.rules.length < rules.length) {
        deps.note(`Consolidated **${rules.length} → ${c.rules.length}** rules` +
          `${c.demoted.length ? `, and moved ${c.demoted.length} piece(s) of process detail to facts` : ""}.`);
        rules = c.rules;
        facts.push(...c.demoted);
      } else {
        deps.note(`⚠️ Consolidation did not run — you are being asked about all ${rules.length} candidates.`);
      }
    }

    if (rules.length) {
      const answer = await deps.ask(
        `**${rules.length} standing rule(s)**. A rule goes into EVERY agent's instructions, ` +
        `for every task, permanently.\n\n${sample(rules)}\n\nImport them?`,
        { options: [
          { label: "Yes — import all", description: `${rules.length} rules become permanent memory` },
          { label: "No", description: "Nothing is written; you can re-run /migrate later" },
        ] },
      );
      if (YES.test(answer.trim())) {
        // Counted from the STORE, not from successful adds: memory supersedes near-duplicates, so an add can
        // succeed while replacing another. Reporting the offer instead of the outcome told the user they had
        // 168 rules when they had 124.
        const before = countKind(deps.memStore, "rule");
        for (const c of rules) await deps.memStore.add(c.text, "rule");
        result.rules = countKind(deps.memStore, "rule") - before;
      } else result.declined.push("rules");
    }

    if (facts.length) {
      const answer = await deps.ask(
        `**${facts.length} project fact(s)** were found — recalled when relevant rather than always.\n\n` +
        `${sample(facts)}\n\nImport them?`,
        { options: [
          { label: "Yes — import all", description: `${facts.length} facts become memory` },
          { label: "No", description: "Nothing is written" },
        ] },
      );
      if (YES.test(answer.trim())) {
        const before = countKind(deps.memStore, "fact");
        for (const c of facts) await deps.memStore.add(c.text, "fact");
        result.facts = countKind(deps.memStore, "fact") - before;
      } else result.declined.push("facts");
    }

    // Reported without being asked about: the user needs to see what was left behind, and re-adding a rule
    // by hand is easy while discovering a silent omission months later is not.
    if (raw.skipped.length) {
      const skipped = raw.skipped;
      const why = skipped.slice(0, SAMPLE).map((c) => `- ~~${c.text.slice(0, 90)}~~ — ${c.reason}`).join("\n");
      deps.note(`**Left behind (${skipped.length})** — these only meant something in the original tool:\n${why}` +
        (skipped.length > SAMPLE ? `\n- _…and ${skipped.length - SAMPLE} more_` : "") +
        `\n\n_If one of these should have transferred, add it with \`/memory add\`._`);
    }
  }

  // --- skills -----------------------------------------------------------------------------------------
  const skills = findings.filter((f) => f.kind === "skill");
  if (skills.length) {
    const answer = await deps.ask(
      `**${skills.length} skill(s)** were found. The format is the same as ours, so they transfer as they are:\n` +
      `${skills.slice(0, SAMPLE).map((s) => `- \`${s.label.split("/").pop()}\``).join("\n")}` +
      `${skills.length > SAMPLE ? `\n- _…and ${skills.length - SAMPLE} more_` : ""}\n\nCopy them into this project?`,
      { options: [
        { label: "Yes — copy all", description: "Copied to .horsecode/skills/, then routed per task" },
        { label: "No", description: "They stay where they are" },
      ] },
    );
    if (YES.test(answer.trim())) {
      for (const s of skills) {
        const name = s.label.split("/").pop()!;
        const dest = join(deps.cwd, ".horsecode", "skills", name, "SKILL.md");
        try {
          await mkdir(dirname(dest), { recursive: true });
          await copyFile(s.path, dest);
          result.skills++;
        } catch { /* one unreadable skill must not stop the rest */ }
      }
    } else result.declined.push("skills");
  }

  // --- MCP servers ------------------------------------------------------------------------------------
  const mcp = await mcpServers(findings);
  if (mcp.length) {
    deps.note(`**${mcp.length} MCP server(s)** are configured for the other tool: ` +
      `${mcp.map((m) => `\`${m}\``).join(", ")}.\n\n_These are not imported automatically — add the ones you ` +
      `want under \`mcp\` in your config, and mark a read-only server \`"readOnly": true\` so every agent can ` +
      `use it._`);
  }

  return result;
}

/** Server names from any of the config files, so the report names them rather than the files. */
async function mcpServers(findings: Finding[]): Promise<string[]> {
  const names = new Set<string>();
  for (const f of findings.filter((x) => x.kind === "mcp")) {
    try {
      const raw = f.text ?? await readFile(f.path, "utf8");
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown>; servers?: Record<string, unknown> };
      for (const key of Object.keys(parsed.mcpServers ?? parsed.servers ?? {})) names.add(key);
    } catch { /* not JSON, or no servers in it */ }
  }
  return [...names];
}

/** The closing report: what the project now has, in the terms the user will see it. */
export function describeResult(r: MigrateResult): string {
  const bits: string[] = [];
  if (r.rules) bits.push(`**${r.rules} rule(s)** — now in every agent's instructions`);
  if (r.facts) bits.push(`**${r.facts} fact(s)** — recalled when relevant`);
  if (r.skills) bits.push(`**${r.skills} skill(s)** — copied to \`.horsecode/skills/\``);
  if (!bits.length) return `Nothing was imported.${r.declined.length ? ` You declined: ${r.declined.join(", ")}.` : ""}`;
  const declined = r.declined.length ? `\n\n_Declined: ${r.declined.join(", ")} — re-run \`/migrate\` to revisit._` : "";
  const left = r.skipped ? `\n\n${r.skipped} instruction(s) were left behind as tool-specific.` : "";
  return `**Migration complete.**\n${bits.map((b) => `- ${b}`).join("\n")}${left}${declined}`;
}
