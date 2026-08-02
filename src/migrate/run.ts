import { cp, lstat, mkdir, readFile, readlink, rm } from "node:fs/promises";
import { recordMigrated } from "./migrated.js";
import { dirname, join, resolve } from "node:path";
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
/**
 * A line that is REWRITTEN in place as a phase proceeds, one per `phase` key.
 *
 * Migration's long stretches were silent: "Reading 223 file(s)…" was printed once and the next word arrived
 * only when every batch had finished — minutes later, with nothing in between to say whether it was working,
 * stuck, or how far along it was. A note per batch would be 24 lines of noise; one line that counts up is
 * the same information without the scroll.
 */
export type Progress = (phase: string, text: string) => void;

export interface MigrateDeps {
  cwd: string;
  home: string;
  provider: Provider;
  /** The model CHAIN, not one model: migration is the one path that used to skip fallbacks entirely. */
  models: string[];
  memStore: MemoryStore;
  ask: Ask;
  note: Note;
  /** Live progress line per phase — see Progress. */
  progress?: Progress;
  /** Enter/leave the status line's running state (shimmer, elapsed timer, token spend). */
  busy?: (phase: string, model?: string) => void;
  idle?: () => void;
  /** Skill names horse-code already has, so a migration never shadows one of ours with a stale copy. */
  existingSkills?: () => string[];
  /** Assigns newly installed skills to the roles that should carry them; returns what it did. */
  assignSkills?: (names: string[]) => Promise<string>;
  signal?: AbortSignal;
}

export interface MigrateResult {
  rules: number;
  facts: number;
  skills: number;
  skipped: number;
  /** Old skill locations deleted after their copy landed — see the removal step. */
  removed: number;
  /** Groups the user declined, so the report is about what happened rather than what was offered. */
  declined: string[];
  /**
   * Batches whose classification failed outright.
   *
   * Reported because "complete" was a lie without it: a run where every batch died on an exhausted quota
   * imported nothing but skills and still signed off with **Migration complete**, with the 219 remembered
   * facts it had silently dropped nowhere in the summary.
   */
  failedBatches: number;
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
  const result: MigrateResult = { rules: 0, facts: 0, skills: 0, skipped: 0, declined: [], failedBatches: 0, removed: 0 };
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
    deps.busy?.("reading instructions", deps.models[0]);
    const extraction = await extractAll({
      provider: deps.provider, models: deps.models, findings: prose,
      ...(deps.signal ? { signal: deps.signal } : {}),
      onProgress: (done, total, source) => deps.progress?.("read",
        `📖 Reading **${done}/${total}** — _${source}_`),
    });
    deps.idle?.();
    /**
     * WHY they could not be read, not just which.
     *
     * The old note listed file names only. When every batch failed against a quota-exhausted model, it read
     * "24 could not be read: CLAUDE.md, CLAUDE.md, CLAUDE.md" — three identical names and no cause, for a
     * failure whose actual message ("all accounts have exhausted their quota, reset after 3h 52m") told the
     * user exactly what to do and when to retry.
     */
    result.failedBatches = extraction.failed.length;
    if (extraction.failed.length) {
      const reasons = [...new Set(extraction.failed.map((f) => f.error))].slice(0, 3);
      deps.note(`⚠️ **${extraction.failed.length} batch(es) could not be read** — ` +
        reasons.map((r) => `\`${r.slice(0, 160)}\``).join("; ") +
        `\n\n_Nothing from those files was imported. Re-run \`/migrate\` once the cause above is cleared._`);
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
      deps.busy?.("consolidating rules", deps.models[0]);
      const c = await consolidateRules({
        provider: deps.provider, models: deps.models, candidates: rules,
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
      deps.idle?.();
      if (c.rules.length < rules.length) {
        deps.note(`Consolidated **${rules.length} → ${c.rules.length}** rules` +
          `${c.demoted.length ? `, kept ${c.demoted.length} as fact(s)` : ""}` +
          `${c.dropped.length ? `, dropped ${c.dropped.length} describing a workflow horse-code replaces` : ""}.`);
        rules = c.rules;
        facts.push(...c.demoted);
        result.skipped += c.dropped.length;
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
  /**
   * Skills we do not already have.
   *
   * A project's own skill for its stack is worth taking; a second copy of one we ship would shadow ours by
   * name and quietly replace a maintained document with a stale one.
   */
  const existing = new Set(deps.existingSkills?.() ?? []);
  const allSkills = findings.filter((f) => f.kind === "skill");
  const skills = allSkills.filter((f) => !existing.has(f.label.split("/").pop()!));
  const alreadyHave = allSkills.length - skills.length;
  if (alreadyHave) deps.note(`${alreadyHave} skill(s) are ones horse-code already ships — left alone.`);
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
      const copied: string[] = [];
      // 73 skill trees is not instant, and a silent minute reads as a hang.
      for (const [i, s] of skills.entries()) {
        const name = s.label.split("/").pop()!;
        deps.progress?.("copy", `📦 Copying **${i + 1}/${skills.length}** — \`${name}\``);
        /**
         * The whole skill DIRECTORY, not just its SKILL.md.
         *
         * Good skills are dispatchers: a short SKILL.md that routes to sibling documents ("read
         * reference/craft.md", "run scripts/context.mjs"). horse-code supports exactly that — the registry
         * keeps each skill's directory and reads its references on demand. Copying the entry point alone
         * produced a skill whose every instruction pointed at a file that was not there.
         *
         * Measured on a real project: 29 of its 76 skills carry more than one file, and the largest of them
         * is 196 KB — a whole tree costs almost nothing next to the instruction it makes usable.
         *
         * `dereference` because a skill directory is often a symlink into another skills root; copying the
         * link itself would land a dangling pointer in the new project.
         */
        const dest = join(deps.cwd, ".horsecode", "skills", name);
        try {
          await mkdir(dirname(dest), { recursive: true });
          await cp(dirname(s.path), dest, { recursive: true, dereference: true });
          copied.push(name);
          result.skills++;
        } catch { /* one unreadable skill must not stop the rest */ }
      }
      /**
       * Copying is not enough.
       *
       * A skill sitting on disk is only DISCOVERABLE — an agent has to notice it and fetch it, which is a
       * coin toss. The point of migrating a project's own skills is that the agents doing that project's
       * work carry them, so the assignment runs here rather than being left as homework.
       */
      /**
       * The originals, once the copy is in place.
       *
       * horse-code reads `.horsecode/skills`, so a skill left at its old path is not a second source — it is
       * a stale twin. It will drift from the copy the moment either is edited, and nothing will say which one
       * an agent read.
       *
       * Only the ones that were actually COPIED are offered for removal. A skill horse-code already ships was
       * deliberately not copied, so deleting it would remove the only copy of this project's variant of it —
       * that is the user's call to make by hand, not a side effect of migrating something else.
       *
       * A skill directory is often a SYMLINK into another skills root. Removing the link alone leaves the
       * content — the actual duplicate — behind, so the link's target goes too. The target is resolved from
       * the link rather than guessed.
       */
      if (copied.length) {
        const removable: { name: string; paths: string[] }[] = [];
        for (const s of skills) {
          const name = s.label.split("/").pop()!;
          if (!copied.includes(name)) continue;
          const dir = dirname(s.path);
          const paths = [dir];
          try {
            if ((await lstat(dir)).isSymbolicLink()) paths.push(resolve(dirname(dir), await readlink(dir)));
          } catch { /* gone already, or unreadable — the removal below tolerates both */ }
          removable.push({ name, paths });
        }
        const answer = await deps.ask(
          `**${removable.length} skill(s)** are now in \`.horsecode/skills/\` AND still at their old path.\n\n` +
          `Remove the originals? horse-code reads its own directory, so the old copies are twins that will ` +
          `drift — but OTHER tools in this project read them too.\n\n` +
          `_Removed from: ${[...new Set(removable.flatMap((r) => r.paths.map((p) => dirname(p).replace(deps.cwd, "."))))].join(", ")}_`,
          { options: [
            { label: "No — keep them", description: "Nothing is deleted; the two copies can diverge" },
            { label: "Yes — remove the originals", description: `${removable.length} directory(ies) deleted from their old location` },
          ] },
        );
        if (YES.test(answer.trim())) {
          for (const [i, r] of removable.entries()) {
            deps.progress?.("remove", `🧹 Removing **${i + 1}/${removable.length}** — \`${r.name}\``);
            for (const path of r.paths) {
              try { await rm(path, { recursive: true, force: true }); result.removed++; }
              catch { /* one that cannot be removed must not stop the rest */ }
            }
          }
          deps.note(`🧹 Removed ${result.removed} original skill location(s). ` +
            `_Both skill trees are usually tracked by git — \`git checkout\` brings them back if this was wrong._`);
        } else result.declined.push("removing the originals");
      }

      if (copied.length && deps.assignSkills) {
        deps.note(`Working out which roles should carry ${copied.length} newly installed skill(s)…`);
        deps.busy?.("assigning skills", deps.models[0]);
        try {
          const assigned = await deps.assignSkills(copied);
          deps.idle?.();
          deps.note(assigned || "No role needed one of them permanently — every agent can still fetch them on demand.");
        } catch (e) {
          deps.idle?.();
          deps.note(`Skill assignment did not run (${e instanceof Error ? e.message : String(e)}) — ` +
            `run \`/roles adjust\` to do it.`);
        }
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

  /**
   * Written down at the end: which of the other tool's rule files this project no longer reads.
   *
   * Their content is now in memory, which every role carries. The files themselves stay — the user may still
   * run those tools — and that is precisely why the record is needed: a second copy of the rules is on disk,
   * it stopped moving the moment it was migrated, and nothing but this record can tell an agent that what it
   * is about to read has been superseded.
   *
   * Only the RULE files. A migrated skill was copied, not distilled, and reading it is reading the thing
   * itself.
   */
  const migratedRules = findings
    .filter((f) => f.kind === "rules" && !f.label.startsWith("~/"))
    .map((f) => f.label);
  if (result.rules > 0 && migratedRules.length) {
    await recordMigrated(deps.cwd, migratedRules).catch(() => { /* bookkeeping must not fail a migration */ });
    deps.note(`🔒 ${migratedRules.map((f) => `\`${f}\``).join(", ")} ${migratedRules.length === 1 ? "is" : "are"} `
      + `no longer read as rules — their content is in this project's memory, and an agent that opens one is `
      + `told where the rules went.`);
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
  if (r.skills) {
    bits.push(`**${r.skills} skill(s)** — copied to \`.horsecode/skills/\`` +
      (r.removed ? `, and ${r.removed} old location(s) removed` : ""));
  }
  // A failure that reached here was already explained in a note; the summary must not contradict it.
  const failed = r.failedBatches
    ? `\n\n⚠️ **${r.failedBatches} batch(es) failed to read** — the instructions and remembered facts in them ` +
      `were NOT imported. Re-run \`/migrate\` once that is cleared.`
    : "";
  if (!bits.length) {
    return `Nothing was imported.${r.declined.length ? ` You declined: ${r.declined.join(", ")}.` : ""}${failed}`;
  }
  const declined = r.declined.length ? `\n\n_Declined: ${r.declined.join(", ")} — re-run \`/migrate\` to revisit._` : "";
  const left = r.skipped ? `\n\n${r.skipped} instruction(s) were left behind as tool-specific.` : "";
  const head = r.failedBatches ? "**Migration finished with failures.**" : "**Migration complete.**";
  return `${head}\n${bits.map((b) => `- ${b}`).join("\n")}${left}${declined}${failed}`;
}
