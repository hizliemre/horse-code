import { parseInline } from "./markdown.js";

// The styled segments of a line (for the fullscreen viewport, content is flattened into a plain line array).
export interface StyledSeg {
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
}
export type StyledLine = StyledSeg[];

const segLen = (l: StyledLine): number => l.reduce((a, s) => a + s.text.length, 0);

/** Wraps styled segments word-by-word (not char): each segment is split into words and packed by width. */
export function wrapSegs(segs: StyledLine, width: number): StyledLine[] {
  const lines: StyledLine[] = [];
  let cur: StyledLine = [];
  let curLen = 0;
  for (const seg of segs) {
    for (const part of seg.text.split(/(\s+)/)) {
      if (part === "") continue;
      const isSpace = /^\s+$/.test(part);
      if (curLen + part.length > width && curLen > 0) {
        lines.push(cur);
        cur = [];
        curLen = 0;
        if (isSpace) continue; // avoid leading space on a line
      }
      cur.push({ ...seg, text: part });
      curLen += part.length;
    }
  }
  if (cur.length) lines.push(cur);
  return lines.length ? lines : [[]];
}

const KEYWORDS = new Set([
  "function", "const", "let", "var", "return", "if", "else", "for", "while", "class", "new",
  "public", "private", "protected", "static", "void", "int", "string", "bool", "async", "await",
  "import", "export", "from", "using", "namespace", "interface", "type", "enum", "extends", "implements",
  "def", "self", "None", "True", "False", "null", "true", "false", "this",
]);

function codeSegs(line: string): StyledLine {
  const cm = line.match(/(\/\/|#).*/);
  const codePart = cm ? line.slice(0, cm.index) : line;
  const commentPart = cm ? line.slice(cm.index) : "";
  const segs: StyledLine = [];
  for (const t of codePart.split(/(\s+|[(){}\[\].,;:]|"[^"]*"|'[^']*')/)) {
    if (t === "") continue;
    let color: string | undefined;
    if (/^".*"$|^'.*'$/.test(t)) color = "green";
    else if (/^\d+(\.\d+)?$/.test(t)) color = "yellow";
    else if (KEYWORDS.has(t)) color = "magenta";
    segs.push({ text: t, color });
  }
  if (commentPart) segs.push({ text: commentPart, dim: true });
  return segs;
}

function inlineSegs(line: string): StyledLine {
  return parseInline(line).map((s) => ({
    text: s.text,
    bold: s.bold,
    italic: s.italic,
    color: s.code ? "yellow" : undefined,
  }));
}

/** Markdown → styled lines (heading, list, code block [language+line no+highlight], bold/code/italic). */
export function flattenMarkdown(text: string, width: number): StyledLine[] {
  const src = text.split("\n");
  const out: StyledLine[] = [];
  let i = 0;
  while (i < src.length) {
    const fence = src[i].match(/^\s*```(\w*)/);
    if (fence) {
      const lang = fence[1] || "";
      const code: string[] = [];
      i++;
      while (i < src.length && !src[i].trim().startsWith("```")) { code.push(src[i]); i++; }
      i++;
      if (lang) out.push([{ text: `╭─ ${lang}`, color: "magenta", dim: true }]);
      const gutter = String(Math.max(1, code.length)).length;
      code.forEach((c, idx) => {
        out.push([{ text: `${String(idx + 1).padStart(gutter, " ")} │ `, dim: true }, ...codeSegs(c)]);
      });
      continue;
    }
    const line = src[i];
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) { out.push(...wrapSegs([{ text: h[2], bold: true, color: "cyan" }], width)); i++; continue; }
    const li = line.match(/^(\s*)[-*+]\s+(.*)/);
    if (li) {
      const wrapped = wrapSegs(inlineSegs(li[2]), Math.max(4, width - 2));
      wrapped.forEach((wl, k) => out.push([{ text: k === 0 ? `${li[1]}• ` : "  " }, ...wl]));
      i++;
      continue;
    }
    out.push(...wrapSegs(inlineSegs(line), width));
    i++;
  }
  return out;
}

/** A file write/edit rendered inline in the chat flow (Claude Code-style): header + a preview of the content. */
export function flattenTool(a: import("../core/types.js").ToolActivity, cols: number): StyledLine[] {
  const width = Math.max(20, cols - 2);
  const trunc = (s: string): string => (s.length > width - 4 ? `${s.slice(0, width - 5)}…` : s);
  const verb = a.tool === "edit" ? "Update" : "Write";
  const header: StyledLine = [
    { text: "● ", color: "#1a9fd8" },
    { text: `${verb}(${a.target})`, bold: true },
    { text: `  · ${a.lines} line${a.lines === 1 ? "" : "s"}`, dim: true },
  ];
  const preview = a.preview ?? [];
  const shown = preview.slice(0, 12);
  const body: StyledLine[] = shown.map((l) => [{ text: "    " }, { text: trunc(l), dim: true }]);
  if (preview.length > 12) body.push([{ text: `    … +${preview.length - 12} more`, dim: true }]);
  return [header, ...body, []]; // trailing blank so blocks don't render flush together
}

/** Converts a message into hanging-indent styled lines (bullet on the first line, continuation indented). */
export function flattenMessage(role: "user" | "assistant", text: string, cols: number): StyledLine[] {
  const width = Math.max(20, cols - 2);
  const bullet: StyledSeg = role === "user" ? { text: "› ", color: "gray" } : { text: "● ", color: "green" };
  const body =
    role === "user"
      ? wrapSegs([{ text, color: "gray" }], width)
      : flattenMarkdown(text, width);
  const withBullet = body.map((line, i) => [i === 0 ? bullet : { text: "  " }, ...line]);
  return [...withBullet, []]; // one empty line at the end of the message → messages don't render flush together
}

/** Logo variant + wordmark based on terminal size → centered styled lines. */
const G: Record<string, string[]> = {
  H: ["█  █", "████", "█  █"], O: ["████", "█  █", "████"], R: ["███ ", "██▄▀", "█  █"],
  S: ["▄███", "▀▀▀▄", "███▀"], E: ["████", "███ ", "████"], C: ["████", "█   ", "████"],
  D: ["███ ", "█  █", "███ "], " ": ["  ", "  ", "  "],
};
const WM = [0, 1, 2].map((r) => "HORSE CODE".split("").map((c) => G[c][r]).join(" "));
const WM_W = Math.max(...WM.map((r) => r.length));
const TAGLINE = "dıgıdık dıgıdık"; // the brand tagline (galloping onomatopoeia), same warm color as the logo
const TAGLINE_COLOR = "#ff9a2e";
export const VERSION = "v0.0.0-beta";
const GREETING = "Welcome to Horse Code — describe a task to build, or type /help for commands.";
const hx = (a: number[]): string =>
  "#" + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

export function flattenSplash(cols: number, _rows: number): StyledLine[] {
  const showWordmark = cols >= WM_W + 2;
  const lines: StyledLine[] = [[]]; // space at the top
  const center = (l: StyledLine): StyledLine => {
    const pad = Math.max(0, Math.floor((cols - segLen(l)) / 2));
    return pad ? [{ text: " ".repeat(pad) }, ...l] : l;
  };
  if (showWordmark) {
    WM.forEach((line, y) => {
      const shade = 1 - 0.22 * (y / (WM.length - 1));
      const segs: StyledLine = [];
      for (let x = 0; x < line.length; x++) {
        const ch = line[x];
        if (ch === " ") { segs.push({ text: " " }); continue; }
        const t = x / (WM_W - 1);
        const col = hx([(0xff + (0xff - 0xff) * t) * shade, (0x6a + (0xc6 - 0x6a) * t) * shade, (0x1a + (0x3a - 0x1a) * t) * shade]);
        segs.push({ text: ch, color: col, bold: true });
      }
      lines.push(center(segs));
    });
    // Tagline + version, centered under the wordmark (same warm color as the logo for the tagline).
    lines.push(center([{ text: TAGLINE, color: TAGLINE_COLOR, bold: true }]));
    lines.push(center([{ text: VERSION, dim: true }]));
    // Greeting (only when it fits without wrapping — center() pads but does not wrap).
    if (cols >= GREETING.length + 2) {
      lines.push([]);
      lines.push(center([{ text: GREETING, dim: true }]));
    }
  }
  lines.push([]);
  return lines;
}
