import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

// Discovered model sources are cached per omniroute baseUrl at ~/.horsecode/sources.json so we don't
// re-probe every launch (probing every source is a handful of live API calls).
interface CacheFile {
  [key: string]: { sources: string[]; at: number };
}

const cachePath = (home: string): string => join(home, ".horsecode", "sources.json");
const keyFor = (baseUrl: string): string => createHash("sha256").update(baseUrl).digest("hex").slice(0, 12);

/** The cached connected sources for this omniroute, or undefined if never discovered. */
export function loadSourceCache(home: string, baseUrl: string): string[] | undefined {
  try {
    const data = JSON.parse(readFileSync(cachePath(home), "utf8")) as CacheFile;
    return data[keyFor(baseUrl)]?.sources;
  } catch {
    return undefined;
  }
}

/** Persist the discovered sources for this omniroute (merging into the per-baseUrl cache file). */
export function saveSourceCache(home: string, baseUrl: string, sources: string[], now: number = Date.now()): void {
  const path = cachePath(home);
  let data: CacheFile = {};
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
  } catch {
    /* first write */
  }
  data[keyFor(baseUrl)] = { sources, at: now };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data), "utf8");
}
