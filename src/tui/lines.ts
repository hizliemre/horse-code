import { parseInline } from "./markdown.js";

// Bir satırın stilli parçaları (fullscreen viewport için içerik → düz satır dizisine flatten edilir).
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

/** Stilli parçaları kelime-bazında sarar (char değil): her segment kelimelerine bölünür, genişliğe göre paketlenir. */
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
        if (isSpace) continue; // satır başında boşluk olmasın
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

/** Markdown → stilli satırlar (başlık, liste, kod-bloğu[dil+satır no+highlight], kalın/kod/italik). */
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

/** Bir mesajı hanging-indent'li stilli satırlara çevirir (bullet ilk satırda, devamı girintili). */
export function flattenMessage(role: "user" | "assistant", text: string, cols: number): StyledLine[] {
  const width = Math.max(20, cols - 2);
  const bullet: StyledSeg = role === "user" ? { text: "› ", color: "gray" } : { text: "● ", color: "green" };
  const body =
    role === "user"
      ? wrapSegs([{ text, color: "gray" }], width)
      : flattenMarkdown(text, width);
  const withBullet = body.map((line, i) => [i === 0 ? bullet : { text: "  " }, ...line]);
  return [...withBullet, []]; // mesaj sonuna bir boş satır → mesajlar bitişik render olmaz
}

/** Terminal boyutuna göre logo varyantı + wordmark → ortalanmış stilli satırlar. */
const G: Record<string, string[]> = {
  H: ["█  █", "████", "█  █"], O: ["████", "█  █", "████"], R: ["███ ", "██▄▀", "█  █"],
  S: ["▄███", "▀▀▀▄", "███▀"], E: ["████", "███ ", "████"], C: ["████", "█   ", "████"],
  D: ["███ ", "█  █", "███ "], " ": ["  ", "  ", "  "],
};
const WM = [0, 1, 2].map((r) => "HORSE CODE".split("").map((c) => G[c][r]).join(" "));
const WM_W = Math.max(...WM.map((r) => r.length));
const hx = (a: number[]): string =>
  "#" + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

export function flattenSplash(cols: number, _rows: number): StyledLine[] {
  const showWordmark = cols >= WM_W + 2;
  const lines: StyledLine[] = [[]]; // üstte boşluk
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
  }
  lines.push([]);
  return lines;
}
