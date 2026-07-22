/** Which glyph language the UI chrome speaks (HORSECODE_ICON_STYLE). */
export type IconStyle = "unicode" | "nerd" | "ascii";

/** The chrome glyphs the TUI paints — one switchable set so minimal/SSH terminals stay legible. */
export interface GlyphSet {
  msgBullet: string; // assistant reply / write-edit block / running-agent row
  userBullet: string; // user prompt
  listBullet: string; // markdown list item
  gutter: string; // line-number separator in file blocks
  fence: string; // code-fence language label
  attach: string; // staged-image indicator
}

/** Reads HORSECODE_ICON_STYLE → a style (default "unicode"; "ascii" and "nerd" are the alternates). */
export function resolveIconStyle(env: Record<string, string | undefined> = process.env): IconStyle {
  const v = (env.HORSECODE_ICON_STYLE ?? "").toLowerCase();
  return v === "ascii" || v === "nerd" ? v : "unicode";
}

const UNICODE: GlyphSet = { msgBullet: "●", userBullet: "›", listBullet: "•", gutter: "│", fence: "╭─", attach: "📎" };
// Plain-ASCII fallback for terminals without box-drawing / emoji (SSH, minimal, some CI PTYs).
const ASCII: GlyphSet = { msgBullet: "*", userBullet: ">", listBullet: "-", gutter: "|", fence: "+-", attach: "[img]" };
// Nerd Font profile: unicode is a safe superset today; nerd-specific icons can be added without touching callers.
const NERD: GlyphSet = { ...UNICODE };

export function glyphSet(style: IconStyle): GlyphSet {
  return style === "ascii" ? ASCII : style === "nerd" ? NERD : UNICODE;
}

/** The resolved glyph set for this process (icon style is fixed at startup via env). */
export const GLYPHS: GlyphSet = glyphSet(resolveIconStyle());
