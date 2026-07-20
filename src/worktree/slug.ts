/** İsmi filesystem-güvenli kebab-case slug'a çevirir; boşsa "job". */
export function toSlug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "job";
}

/** taken(slug) true dönerse -2, -3… ekleyerek tekil slug üretir. */
export function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  if (!taken(base)) return base;
  let n = 2;
  while (taken(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
