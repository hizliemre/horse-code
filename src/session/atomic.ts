import { rename, rm, writeFile } from "node:fs/promises";
import { renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * Writing state that cannot be rebuilt.
 *
 * `writeFile` truncates the target before it writes, so a process that dies mid-write leaves NOTHING. That
 * is not hypothetical: a real project's `memory.jsonl` went from 1471 entries to a 0-byte file the moment
 * its process exited. The file is not in git, there was no backup, and rebuilding it cost three quarters of
 * a million tokens.
 *
 * `rename` is atomic within a filesystem, so the worst a crash can do is leave the PREVIOUS good file in
 * place — a stale state, never an empty one.
 *
 * It lives here rather than beside each caller because a safety primitive that exists in four copies is one
 * that gets fixed in one of them. The board already had its own; this is that code, shared.
 */

/**
 * A temp name unique to THIS write, beside the target.
 *
 * Same filesystem, so the rename stays a metadata operation and never a copy across devices — that was
 * always the point. What the name also has to be is unique, and for a while it was not: every write used
 * `<path>.tmp`, so two concurrent writers shared one scratch file. Measured with six writers, the shape this
 * module exists to prevent came straight back — 20 of 40 rounds published a file that would not parse, plus
 * 200 failed writes as each rename pulled the temp file out from under the next.
 *
 * Concurrency is not exotic here: the trace runner writes its index from six workers, and parallel tasks
 * write the board.
 */
let seq = 0;
const tmpName = (path: string): string => `${path}.${process.pid}.${seq++}.tmp`;

export async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = tmpName(path);
  try {
    await writeFile(tmp, data, "utf8");
    await rename(tmp, path);
  } catch (e) {
    // Now that the name is unique, a failed write would otherwise leave scratch behind for good — and traces
    // live in a COMMITTED directory, where a stray file shows up in everyone's `git status`.
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** For the callers that must not await — a checkpoint written from a synchronous path. */
export function writeAtomicSync(path: string, data: string): void {
  const tmp = tmpName(path);
  try {
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* the throw below is the real news */ }
    throw e;
  }
}
