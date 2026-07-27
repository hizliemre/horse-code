import type { Card } from "../board/board.js";
import type { ImplementerRole } from "./task-types.js";

/**
 * Which implementer a task belongs to, decided from evidence rather than a model call.
 *
 * The router used to spend one call per task on the TITLE ALONE — the only thing it was given. A title is
 * the weakest description of a task on the board: the files it writes and what must be true when it is done
 * say far more, and both were sitting on the card unused.
 *
 * The same shape as skill routing (`src/skills/route.ts`): decide what the evidence settles, and pay for a
 * judgement only where it is genuinely open. Most tasks are not close calls.
 */

/** Presentation, and nothing else. A task writing one of these is doing interface work. */
const STYLE_EXT = [".css", ".scss", ".sass", ".less", ".styl"];
/** Presentation plus structure — a template is still the surface the user sees. */
const MARKUP_EXT = [".html", ".htm", ".svg", ".vue", ".svelte"];
/** UI, but routinely plain logic too: a `.tsx` file is as often a hook or a context as it is a view. */
const COMPONENT_EXT = [".tsx", ".jsx"];
const BACKEND_EXT = [".sql", ".prisma", ".proto", ".go", ".py", ".rb", ".php", ".java", ".rs", ".kt"];
const BACKEND_DIR = ["server", "api", "backend", "db", "database", "migrations", "migration", "infra", "worker", "jobs"];
const UI_DIR = ["ui", "components", "component", "views", "view", "pages", "page", "screens", "styles", "theme", "themes", "layouts", "widgets"];
/**
 * Words that name the work itself as design work.
 *
 * Kept to terms whose subject IS the interface. Deliberately excludes words like "button" or "form" — a task
 * can add a form's validation rules without any of it being design.
 */
const DESIGN_WORDS = [
  "style", "styles", "styling", "theme", "theming", "layout", "design", "visual", "visuals",
  "animation", "animate", "transition", "responsive", "accessibility", "a11y", "color", "colors",
  "colour", "typography", "spacing", "icon", "icons", "ui", "ux", "polish", "palette", "css",
];

const ext = (p: string): string => {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
};
const segments = (p: string): string[] => p.toLowerCase().split(/[/\\]/).slice(0, -1);
const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export interface RoleEvidence {
  /** Undefined when the evidence does not settle it — that is the case worth a model call. */
  role?: ImplementerRole;
  /** What decided it, for the note in the run log. */
  why: string;
}

/** Reads the card's files and title. Returns no role when the two kinds of evidence disagree, or are absent. */
export function routeByEvidence(card: Pick<Card, "title" | "files">): RoleEvidence {
  const files = card.files.map((f) => f.trim()).filter(Boolean);
  const exts = files.map(ext);
  const dirs = files.flatMap(segments);
  const title = words(card.title);

  const hasStyle = exts.some((e) => STYLE_EXT.includes(e));
  const hasMarkup = exts.some((e) => MARKUP_EXT.includes(e));
  const hasComponent = exts.some((e) => COMPONENT_EXT.includes(e));
  const hasUiDir = dirs.some((d) => UI_DIR.includes(d));
  const designWord = title.find((w) => DESIGN_WORDS.includes(w));
  const backend = exts.some((e) => BACKEND_EXT.includes(e)) || dirs.some((d) => BACKEND_DIR.includes(d));

  // Nothing about this task points at the interface at all — not a file, not a word.
  if (!hasStyle && !hasMarkup && !hasComponent && !hasUiDir && !designWord) {
    return { role: "coder", why: files.length ? "no interface work in its files or title" : "nothing about it is interface work" };
  }
  // Presentation assets, or a title that names design as the work — and no server-side counterweight.
  if ((hasStyle || hasMarkup || designWord) && !backend) {
    const reason = hasStyle || hasMarkup
      ? `writes ${files.find((f) => STYLE_EXT.includes(ext(f)) || MARKUP_EXT.includes(ext(f)))}`
      : `"${designWord}" is the work`;
    return { role: "designer", why: reason };
  }
  // A `.tsx` on its own, or design words over backend files: genuinely open. Worth asking.
  return { why: hasComponent && !hasStyle && !hasMarkup ? "component files could be either" : "the evidence points both ways" };
}
