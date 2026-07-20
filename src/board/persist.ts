import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Board } from "./board.js";

export async function saveBoard(board: Board, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(board.toJSON(), null, 2), "utf8");
}

export async function loadBoard(path: string): Promise<Board> {
  const raw = await readFile(path, "utf8");
  return Board.fromJSON(JSON.parse(raw));
}
