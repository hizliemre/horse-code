import { mkdir, readFile } from "node:fs/promises";
import { writeAtomic } from "../session/atomic.js";
import { dirname } from "node:path";
import { Board } from "./board.js";

/**
 * One in-flight write per board file, plus at most one waiting behind it.
 *
 * The board is rewritten on EVERY mutation, from a fire-and-forget `onChange` handler, while the wave engine
 * mutates it from several tasks running at once. Nothing serialised those writes, so two `writeFile` calls
 * overlapped: each truncated the file and then wrote from its own offset, and the longer one's tail survived
 * past the shorter one's end.
 *
 * That is not a theory. A real board was found holding a complete, valid 95-card document followed by 2056
 * bytes of the previous, longer version, starting mid-sentence. It parsed as "Extra data" and would have
 * taken the next run's resume with it — the board is the only record of which tasks are already merged.
 *
 * A queued write re-serialises the board when it RUNS, not when it was asked for, so collapsing a burst of
 * mutations into one write loses nothing: the last write always reflects the newest state.
 */
interface Writer { chain: Promise<void>; queued: boolean; next?: Board }
const writers = new Map<string, Writer>();

/**
 * Deliberately NOT `async`: everything up to the first await must run synchronously, so a `flushBoard` called
 * straight after a fire-and-forget `saveBoard` finds the write registered. Awaiting `mkdir` first put the
 * registration behind a microtask, and the flush then waited for nothing at all.
 */
export function saveBoard(board: Board, path: string): Promise<void> {
  const w = writers.get(path) ?? { chain: Promise.resolve(), queued: false };
  writers.set(path, w);
  // The queued write serialises whatever is newest when it runs — including a DIFFERENT board handed to the
  // same path, which a closure over the first caller's board would silently drop.
  w.next = board;
  if (w.queued) return w.chain; // a write is already scheduled after this mutation; it will include it
  w.queued = true;
  w.chain = w.chain.then(async () => {
    w.queued = false; // from here on a new mutation needs its own write
    await mkdir(dirname(path), { recursive: true });
    await writeAtomic(path, JSON.stringify(w.next!.toJSON(), null, 2));
  });
  return w.chain;
}

/**
 * Waits for the board's pending write, if any.
 *
 * `onChange` saves fire-and-forget, so a run could return — and its caller could tear the session directory
 * down — while the state of record was still being written. The board decides what a resume picks up; it must
 * be on disk before anyone reads or deletes it.
 */
export function flushBoard(path: string): Promise<void> {
  return writers.get(path)?.chain ?? Promise.resolve();
}

export async function loadBoard(path: string): Promise<Board> {
  const raw = await readFile(path, "utf8");
  return Board.fromJSON(JSON.parse(raw));
}
