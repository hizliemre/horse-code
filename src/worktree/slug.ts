// Cap so a slug stays a valid single path component (filesystem limit ~255) and a valid git
// ref segment, leaving room for uniqueSlug's "-N" suffix and branch prefixes like "hc/<slug>/t/…".
const MAX_SLUG = 60;
// Keep names short + meaningful: at most a handful of dash-joined words (worktree/branch names should
// read like "add-login-page", not a whole sentence). The refiner supplies a clean English title upstream;
// this is the defensive cap for any fallback name.
const MAX_WORDS = 5;

/** Converts a name to a filesystem-safe kebab-case slug (≤5 words, length-capped); "job" if empty. */
export function toSlug(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ") // non-alphanumerics → word separators
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_WORDS);
  const s = words.join("-").slice(0, MAX_SLUG).replace(/-+$/g, "");
  return s || "job";
}

/** Generates a unique slug by appending -2, -3… when taken(slug) returns true. */
export function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  if (!taken(base)) return base;
  let n = 2;
  while (taken(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
