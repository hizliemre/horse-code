import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./session-scope.js";
import { writeAtomic } from "../session/atomic.js";

/**
 * What the last turn actually DID, kept so the next one can be asked about it.
 *
 * The gap this closes was reported plainly: a constitution was updated wrongly, the user said "undo your
 * changes, go back to the previous version" — and the run wrote a THIRD constitution. Nothing was broken in
 * the model's understanding of the sentence. The sentence simply had no referent: the only thing carried
 * between turns was the transcript's TEXT, so "your changes" pointed at nothing, and a request that operates
 * on the previous turn was classified as a request to produce a new one.
 *
 * Two things are recorded, and the distinction matters more than either:
 *
 * - Work written IN PLACE (the constitution, a rule file) is recorded with the content it replaced. That is
 *   what makes an undo exact rather than a re-derivation — restoring bytes, not asking a model to remember.
 * - Work that produced a BRANCH is recorded as a branch. It is not undone here: it was never in the user's
 *   working tree, and dropping someone's branch on an inferred instruction is not a favour.
 */

/** Ceilings, so a record of what changed never becomes a second copy of the repository. */
export const MAX_SNAPSHOT_BYTES = 512_000;
export const MAX_SNAPSHOT_FILES = 40;

export const TURN_FILE = join(".horsecode", "last-turn.json");

export interface FileSnapshot {
  /** Repo-relative path that was written. */
  file: string;
  /** What was there before — absent when the file did not exist, which is itself the thing to restore to. */
  before?: string;
  /** True when the file was created by this turn, so undoing means deleting it. */
  created: boolean;
}

export interface TurnEffect {
  version: 1;
  at: number;
  /** The request, as the user phrased it — so a summary can name what the turn was for. */
  prompt: string;
  kind: "in-place" | "branch" | "none";
  files: FileSnapshot[];
  /** Set for pipeline work: the branch that carries it, which this module never touches. */
  branch?: string;
  /** Files the turn changed but did not snapshot, with why — never silently dropped. */
  unsnapshotted: string[];
}

const path = (cwd: string): string => join(stateRoot(cwd), TURN_FILE);

/**
 * Reads what the file was before a turn overwrites it.
 *
 * Called BEFORE the write, which is the only moment the previous content still exists. A file that is absent
 * is recorded as created — undoing that means removing it again, and "there was nothing here" is as real a
 * previous state as any other.
 */
export async function snapshot(cwd: string, file: string): Promise<FileSnapshot> {
  const abs = join(stateRoot(cwd), file);
  if (!existsSync(abs)) return { file, created: true };
  try {
    const before = await readFile(abs, "utf8");
    if (before.length > MAX_SNAPSHOT_BYTES) return { file, created: false };
    return { file, before, created: false };
  } catch {
    return { file, created: false };
  }
}

export async function recordTurn(cwd: string, effect: Omit<TurnEffect, "version" | "at">, now = Date.now()): Promise<void> {
  const kept = effect.files.slice(0, MAX_SNAPSHOT_FILES);
  const dropped = effect.files.slice(MAX_SNAPSHOT_FILES).map((f) => f.file);
  const rec: TurnEffect = {
    version: 1,
    at: now,
    ...effect,
    files: kept,
    unsnapshotted: [...effect.unsnapshotted, ...dropped],
  };
  const p = path(cwd);
  await mkdir(dirname(p), { recursive: true });
  await writeAtomic(p, `${JSON.stringify(rec, null, 2)}\n`);
}

export async function lastTurn(cwd: string): Promise<TurnEffect | undefined> {
  try {
    const raw = JSON.parse(await readFile(path(cwd), "utf8")) as TurnEffect;
    return raw?.version === 1 && Array.isArray(raw.files) ? raw : undefined;
  } catch { return undefined; }
}

/** Forgets the record — after an undo, so the same turn cannot be undone twice. */
export async function clearTurn(cwd: string): Promise<void> {
  try { await writeAtomic(path(cwd), `${JSON.stringify({ version: 1, at: 0, prompt: "", kind: "none", files: [], unsnapshotted: [] })}\n`); }
  catch { /* a stale record is a smaller problem than a failed turn */ }
}

export interface UndoResult {
  restored: string[];
  removed: string[];
  failed: { file: string; error: string }[];
  /** Nothing was undone, and this says why — a branch, an empty record, or no record at all. */
  refused?: string;
}

/**
 * Puts the files back exactly as they were.
 *
 * Deterministic on purpose. The model's part is deciding that "undo it" IS an undo request; what that means
 * afterwards is a question git and a snapshot can answer exactly, and a wrong undo is worse than the wrong
 * write it was meant to fix.
 */
export async function undoTurn(cwd: string, effect: TurnEffect | undefined): Promise<UndoResult> {
  const out: UndoResult = { restored: [], removed: [], failed: [] };
  // Branch first: that record carries no files by definition, so an "is it empty?" test would answer it with
  // "nothing was recorded" — which is both wrong and the least useful thing to say to someone asking to undo.
  if (effect?.kind === "branch") {
    out.refused = `The last turn's work is on the branch \`${effect.branch ?? "?"}\`, not in your working tree. `
      + `Nothing here was overwritten, so there is nothing to restore — drop the branch yourself if you want it gone.`;
    return out;
  }
  if (!effect || effect.kind === "none" || !effect.files.length) {
    out.refused = "There is nothing recorded to undo — the last turn changed no files in your working tree.";
    return out;
  }
  const { rm } = await import("node:fs/promises");
  for (const f of effect.files) {
    const abs = join(stateRoot(cwd), f.file);
    try {
      if (f.created) { await rm(abs, { force: true }); out.removed.push(f.file); continue; }
      if (f.before === undefined) {
        out.failed.push({ file: f.file, error: "too large to snapshot — restore it from git" });
        continue;
      }
      await mkdir(dirname(abs), { recursive: true });
      await writeAtomic(abs, f.before);
      out.restored.push(f.file);
    } catch (e) {
      out.failed.push({ file: f.file, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** One line for the next turn's context: what the previous turn did, so "undo it" has a referent. */
export function describeForContext(effect: TurnEffect | undefined): string | undefined {
  if (!effect || effect.kind === "none" || (!effect.files.length && !effect.branch)) return undefined;
  if (effect.kind === "branch") {
    return `Your previous turn produced work on the branch \`${effect.branch}\` for: "${effect.prompt}".`;
  }
  const names = effect.files.map((f) => f.file).join(", ");
  return `Your previous turn wrote ${names} in the user's working tree, for: "${effect.prompt}". `
    + `The previous contents are recorded, so a request to undo or revert refers to THESE files.`;
}

/** What the user is told after an undo. */
export function describeUndo(r: UndoResult): string {
  if (r.refused) return r.refused;
  const bits: string[] = [];
  if (r.restored.length) bits.push(`**Restored** ${r.restored.map((f) => `\`${f}\``).join(", ")} to the version before the last change.`);
  if (r.removed.length) bits.push(`**Removed** ${r.removed.map((f) => `\`${f}\``).join(", ")} — the last turn created ${r.removed.length === 1 ? "it" : "them"}.`);
  if (r.failed.length) {
    bits.push(`⚠️ Could not restore ${r.failed.map((f) => `\`${f.file}\` (${f.error})`).join(", ")}.`);
  }
  return bits.join("\n\n");
}
