import { patchConfig } from "./patch.js";
import type { PermissionMode } from "../core/types.js";

/**
 * Remembering the permission mode.
 *
 * `config.mode` has always existed and has always been read at startup; `/mode` only ever changed the running
 * engine. So the one setting a user changes most often — how much they want to be asked — was the one that
 * did not survive the session, and it had to be set again every time.
 *
 * Written through `patchConfig` like every other deliberate choice: the file holds the api key, and there is
 * exactly one safe way to modify it.
 */
export async function saveMode(home: string, mode: PermissionMode): Promise<boolean> {
  return patchConfig(home, (current) => ({ ...current, mode }));
}
