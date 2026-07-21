// Cap so a slug stays a valid single path component (filesystem limit ~255) and a valid git
// ref segment, leaving room for uniqueSlug's "-N" suffix and branch prefixes like "hc/<slug>/t/…".
const MAX_SLUG = 60;

/** Converts a name to a filesystem-safe kebab-case slug (length-capped); "job" if empty. */
export function toSlug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, ""); // drop a trailing dash the slice may have left mid-word
  return s || "job";
}

/** Generates a unique slug by appending -2, -3… when taken(slug) returns true. */
export function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  if (!taken(base)) return base;
  let n = 2;
  while (taken(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
