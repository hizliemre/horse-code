// Cap so a slug stays a valid single path component (filesystem limit ~255) and a valid git
// ref segment, leaving room for uniqueSlug's "-N" suffix and branch prefixes like "hc/<slug>/t/…".
const MAX_SLUG = 60;
// Keep names short + meaningful: at most a handful of dash-joined words (worktree/branch names should
// read like "login-page", not a whole sentence). The refiner supplies a clean English title upstream;
// this is the defensive cap for any fallback name.
const MAX_WORDS = 5;

/**
 * Action verbs a task description opens with.
 *
 * A worktree names the THING being worked on, not the doing of it: `luxury-todo-app`, not
 * `build-luxury-todo-app`. Every task starts with a verb, so every name inherited one and the verb carried
 * no information — of course it is being built, that is what the tool does.
 */
const LEADING_VERBS = new Set([
  "add", "build", "create", "implement", "make", "write", "develop", "design", "generate", "introduce",
  "fix", "update", "change", "modify", "refactor", "rewrite", "improve", "enhance", "optimize", "clean",
  "setup", "configure", "install", "remove", "delete", "drop", "rename", "migrate", "move", "port",
  "support", "enable", "disable", "finalize", "complete", "finish", "expand", "extend", "set", "apply",
]);

/**
 * Articles left behind once the verb goes: "build a login page" → "login page".
 *
 * Only the articles. An earlier version also dropped "new", "some", "our" and "my" — which read as filler
 * in a sentence but are the distinguishing word in a name: `new-empty` and `old-empty` are two different
 * worktrees, and one of them became `empty`.
 */
const FILLERS = new Set(["a", "an", "the"]);

/**
 * Strips the leading action from a task description.
 *
 * Only from the FRONT, and never everything: a name that is nothing but a verb ("refactor") keeps it,
 * because an empty name is worse than a slightly wrong one.
 */
export function dropLeadingAction(words: string[]): string[] {
  let i = 0;
  // A verb is only an ACTION when the description opens with it. "the build pipeline" is a thing called a
  // build pipeline; dropping `build` there would name the work after the wrong noun.
  if (words.length && LEADING_VERBS.has(words[0])) {
    i = 1;
    while (i < words.length && FILLERS.has(words[i])) i++;
  } else {
    while (i < words.length && FILLERS.has(words[i])) i++; // a bare article carries nothing either
  }
  return i < words.length ? words.slice(i) : words;
}

/** Converts a name to a filesystem-safe kebab-case slug: the SUBJECT, ≤5 words, length-capped; "job" if empty. */
export function toSlug(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ") // non-alphanumerics → word separators
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const named = dropLeadingAction(words).slice(0, MAX_WORDS);
  const s = named.join("-").slice(0, MAX_SLUG).replace(/-+$/g, "");
  return s || "job";
}

/** Generates a unique slug by appending -2, -3… when taken(slug) returns true. */
export function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  if (!taken(base)) return base;
  let n = 2;
  while (taken(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
