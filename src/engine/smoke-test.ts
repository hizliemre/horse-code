import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Walking a person through the manual verification a run wrote, one step at a time.
 *
 * Every feature run ends with a verification guide it composed itself — scenarios, the evidence each one
 * needs, and a table whose rows all read `kod üzerinden doğrulandı` ("verified from the source"). That is an
 * honest thing for a run to say: it read the code and could not start a database, a log stack or a browser.
 * What the document then asks for is exactly what nobody was doing:
 *
 *   "Kaynak-akışı kanıtları yürütülmüş manuel senaryo kanıtı değildir. Canlı doğrulama yapıldığında ilgili
 *    satır, gerçek UI/API gözlemi ile DB ve log kanıtı eklenerek yalnız `geçti` veya `başarısız` durumuna
 *    güncellenir."
 *
 * So this reads the guide the run wrote, hands out one instruction at a time, waits for what was actually
 * observed, and writes that back into the table as `geçti` or `başarısız` with the evidence beside it. The
 * document becomes the record it was written to be.
 *
 * What this does NOT do is reach the database or the log stack itself. Nothing here is configured to: there
 * is no connection string in the project's settings and no Loki client on the machine. Pretending otherwise
 * would put an unverified claim in a file whose whole purpose is to separate what was seen from what was
 * assumed — the same distinction the run was careful to make. The evidence is what the person pastes back.
 */

/** One thing to do and report on, in the order the guide puts them. */
export interface SmokeStep {
  /** 1-based, across the whole guide — "step 7 of 24" is what a person tracking progress wants. */
  n: number;
  /** The heading it came from, e.g. "Senaryo 3 — Ürün eşleştirme ve fiyat anlık görüntüsü". */
  scenario: string;
  /** Which scenario, 1-based, for writing the outcome back to the right table row. */
  scenarioIndex: number;
  instruction: string;
}

export interface SmokeGuide {
  path: string;
  title: string;
  /** What must be true before any of it can start — shown once, before the first step. */
  preconditions: string[];
  steps: SmokeStep[];
  /** The scenario headings, in order, so an outcome can be paired with its table row. */
  scenarios: string[];
}

/** Where a feature's verification guide lives, if the run wrote one. */
export function guidePath(workdir: string, slug: string): string | undefined {
  const p = join(workdir, "specs", slug, "quickstart.md");
  return existsSync(p) ? p : undefined;
}

/**
 * Splits a scenario's prose into the separate things it asks for.
 *
 * The guide writes each scenario as a short paragraph of imperatives — "…gönderin, …kabul edin ve …kontrol
 * edin. …doğrulayın. …doğrulayın." A sentence is one instruction a person can carry out and report on; the
 * paragraph as a whole is four or five, and handing it over at once is what makes a manual pass drift.
 */
export function splitInstructions(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12);
}

/**
 * Reads the guide into ordered steps.
 *
 * The `## Doğrulama kaydı` section is deliberately excluded: it is the RECORD, not the work, and stepping a
 * person through a table of past conclusions would ask them to re-verify what this run is about to write.
 */
export function parseGuide(path: string, markdown: string): SmokeGuide {
  const lines = markdown.split("\n");
  const title = lines.find((l) => l.startsWith("# "))?.slice(2).trim() ?? "Manual verification";

  const preconditions: string[] = [];
  const scenarios: string[] = [];
  const steps: SmokeStep[] = [];
  let section: "pre" | "scenario" | "other" = "other";
  let scenario = "";
  let buffer: string[] = [];

  const flush = (): void => {
    if (!scenario) { buffer = []; return; }
    const text = buffer.join(" ").trim();
    for (const instruction of splitInstructions(text)) {
      /**
       * `scenarios.length - 1`, because the heading was pushed before this ran. Off by one, it wrote every
       * outcome into the NEXT scenario's table row — a walk would have recorded scenario 1's result against
       * scenario 2 and left the last one unwritten. Caught by the test that pairs a step with its heading.
       */
      steps.push({ n: steps.length + 1, scenario, scenarioIndex: Math.max(0, scenarios.length - 1), instruction });
    }
    buffer = [];
  };

  for (const line of lines) {
    const h2 = /^##\s+(?!#)(.*)$/.exec(line);
    const h3 = /^###\s+(.*)$/.exec(line);
    if (h2) {
      flush();
      scenario = "";
      // The record is what this run WRITES; it is not a step to walk anyone through.
      section = /ön koşul|precondition/i.test(h2[1]) ? "pre"
        : /senaryo|scenario/i.test(h2[1]) ? "scenario" : "other";
      continue;
    }
    if (h3) {
      flush();
      if (section === "scenario") { scenario = h3[1].trim(); scenarios.push(scenario); }
      continue;
    }
    const text = line.trim();
    if (!text) { flush(); continue; }
    if (section === "pre") {
      const item = /^\d+\.\s+(.*)$/.exec(text)?.[1] ?? /^[-*]\s+(.*)$/.exec(text)?.[1];
      if (item) preconditions.push(item);
      continue;
    }
    if (section === "scenario" && scenario) buffer.push(text);
  }
  flush();
  return { path, title, preconditions, steps, scenarios };
}

/** What a person is shown for one step. */
export function renderStep(step: SmokeStep, total: number): string {
  return `**Adım ${step.n}/${total}** — _${step.scenario}_\n\n${step.instruction}`;
}

/** The statuses the guide itself defines. Nothing else may be written into its table. */
export const STATUSES = ["geçti", "başarısız", "çalıştırılmadı"] as const;
export type SmokeStatus = (typeof STATUSES)[number];

/**
 * Writes one scenario's outcome into the guide's own table, replacing what the run had assumed.
 *
 * Matched on the row's leading number rather than on its wording: the run writes the scenario column as
 * "1 — talep ve kabul" while the heading reads "Senaryo 1 — Kayıtlı hedefe talep ve kabul", and pairing on
 * text would silently fail on exactly the rows this exists to update.
 *
 * The evidence REPLACES the source-reading note, because the two are different claims and the document says
 * so — keeping both would leave a row asserting it was verified two incompatible ways.
 */
export function recordOutcome(
  markdown: string, scenarioIndex: number, status: SmokeStatus, evidence: string,
): string {
  const want = scenarioIndex + 1;
  return markdown.split("\n").map((line) => {
    if (!line.startsWith("|")) return line;
    const cells = line.split("|");
    // | scenario | status | evidence |  → ["", scenario, status, evidence, ""]
    if (cells.length < 4) return line;
    if (Number(/^\s*(\d+)/.exec(cells[1] ?? "")?.[1]) !== want) return line;
    cells[2] = ` ${status} `;
    cells[3] = ` ${evidence.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim()} `;
    return cells.join("|");
  }).join("\n");
}

/** What a person reported for one step. */
export interface StepResult {
  step: SmokeStep;
  status: SmokeStatus;
  /** What they actually saw — the API response, the row, the log line. Empty when they skipped it. */
  evidence: string;
}

/**
 * One scenario's row, folded from the steps that make it up.
 *
 * The guide's table is per SCENARIO and the walk is per step, so a row cannot be written until its steps are
 * done — written per step, each one would overwrite the last and the row would end up reporting only the
 * final sentence.
 *
 * A single failure decides the row. A scenario whose third check failed is not a scenario that passed, and
 * recording it as passed because the other four were fine is precisely the silent-success this document
 * exists to prevent. All-skipped stays `çalıştırılmadı`, because nobody ran it.
 */
export function scenarioOutcome(results: readonly StepResult[]): { status: SmokeStatus; evidence: string } {
  const status: SmokeStatus = results.some((r) => r.status === "başarısız") ? "başarısız"
    : results.every((r) => r.status === "çalıştırılmadı") ? "çalıştırılmadı"
    : "geçti";
  const evidence = results
    .filter((r) => r.evidence.trim())
    .map((r) => `${r.step.n}. ${r.evidence.trim()}`)
    .join(" ");
  return { status, evidence: evidence || "gözlem kaydedilmedi" };
}

/**
 * Where a feature's verification guide actually is.
 *
 * Not simply under the project root: a run's work lives on a session BRANCH, in
 * `.horsecode/worktrees/<session>/base`, and stays there until it is merged. Measured on the project this
 * was written for — the root's `specs/` held 002, 003 and 004 while the feature just finished, 005, existed
 * only in the worktree. Looking in one place would have reported "no guide" for the run that had just
 * written one.
 *
 * The newest spec folder wins, and the caller is told the choice was a guess: on a project with one feature
 * in flight it is right, and it is still a guess.
 */
export function findGuide(projectRoot: string): { root: string; slug: string; path: string } | undefined {
  const roots = [projectRoot, ...worktreeRoots(projectRoot)];
  let best: { root: string; slug: string; path: string } | undefined;
  for (const root of roots) {
    let names: string[] = [];
    try { names = readdirSync(join(root, "specs")); } catch { continue; }
    for (const slug of names) {
      if (!/^\d{3}-/.test(slug)) continue;
      const path = join(root, "specs", slug, "quickstart.md");
      if (!existsSync(path)) continue;
      // Highest feature number across every root — the one a run has just finished.
      if (!best || slug > best.slug) best = { root, slug, path };
    }
  }
  return best;
}

/** The `base` checkout of every session this project has opened. */
function worktreeRoots(projectRoot: string): string[] {
  const dir = join(projectRoot, ".horsecode", "worktrees");
  try {
    return readdirSync(dir).map((s) => join(dir, s, "base")).filter((p) => existsSync(p));
  } catch { return []; }
}

/** How far along a walk is, for the line shown between steps. */
export function progressLine(done: number, total: number): string {
  const width = 24;
  const filled = total ? Math.round((done / total) * width) : 0;
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}  ${done}/${total}`;
}

/**
 * The guide, loaded and parsed, or the reason there is nothing to walk.
 *
 * A missing guide is the ordinary case for a project that has not finished a feature run, and it is worth
 * saying which of the two it is rather than reporting an empty walk.
 */
export function loadGuide(projectRoot: string): (SmokeGuide & { slug: string }) | { error: string } {
  const found = findGuide(projectRoot);
  if (!found) {
    return { error: "No `specs/NNN-…/quickstart.md` in this project or any of its session worktrees — a feature run writes one when it finishes." };
  }
  const guide = parseGuide(found.path, readFileSync(found.path, "utf8"));
  if (!guide.steps.length) return { error: `${found.path} has no scenarios to walk — it may not be a verification guide.` };
  return { ...guide, slug: found.slug };
}
