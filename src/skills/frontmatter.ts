/** Reads name/description from `---` frontmatter; otherwise { body: raw }. No YAML dependency. */
export function parseFrontmatter(raw: string): { name?: string; description?: string; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { body: raw };
  const [, fm, body] = m;
  const read = (key: string): string | undefined => {
    const line = fm.split(/\r?\n/).find((l) => l.trimStart().startsWith(`${key}:`));
    if (!line) return undefined;
    let v = line.slice(line.indexOf(":") + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    return v;
  };
  return { name: read("name"), description: read("description"), body };
}
