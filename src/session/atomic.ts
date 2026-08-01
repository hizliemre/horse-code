import { rename, writeFile } from "node:fs/promises";
import { renameSync, writeFileSync } from "node:fs";

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

/** Same-filesystem temp name, so the rename is a metadata operation and never a copy across devices. */
const tmpName = (path: string): string => `${path}.tmp`;

export async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = tmpName(path);
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

/** For the callers that must not await — a checkpoint written from a synchronous path. */
export function writeAtomicSync(path: string, data: string): void {
  const tmp = tmpName(path);
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
}
