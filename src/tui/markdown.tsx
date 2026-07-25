import React from "react";
import { Box, Text } from "ink";

export interface InlineSeg {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

/**
 * Emoji whose BASE codepoint is narrow but which terminals draw two columns wide once the variation selector
 * (U+FE0F) asks for the emoji presentation — ⚠️, ♻️, ❗️ and friends. Ink measures them as one column, so the
 * space that follows is overdrawn by the glyph's second column and the text collides with the icon. Naturally
 * wide emoji (📋, ✅, 🧠 …) measure correctly and are left alone.
 */
const NARROW_EMOJI_AT_START = /^(\p{Extended_Pictographic}\uFE0F)( )/u;

/** Restores the gap after a variation-selector emoji that the terminal renders wider than Ink measured. */
export function padNarrowEmoji(line: string): string {
  return line.replace(NARROW_EMOJI_AT_START, "$1 $2");
}

/** Inline markdown: **bold**, `code`, _italic_. */
export function parseInline(raw: string): InlineSeg[] {
  const line = padNarrowEmoji(raw);
  const segs: InlineSeg[] = [];
  let i = 0;
  const flush = (from: number, to: number): void => {
    if (to > from) segs.push({ text: line.slice(from, to) });
  };
  while (i < line.length) {
    if (line.startsWith("**", i)) {
      const end = line.indexOf("**", i + 2);
      if (end !== -1) { segs.push({ text: line.slice(i + 2, end), bold: true }); i = end + 2; continue; }
    }
    if (line[i] === "`") {
      const end = line.indexOf("`", i + 1);
      if (end !== -1) { segs.push({ text: line.slice(i + 1, end), code: true }); i = end + 1; continue; }
    }
    if (line[i] === "_") {
      const end = line.indexOf("_", i + 1);
      if (end !== -1) { segs.push({ text: line.slice(i + 1, end), italic: true }); i = end + 1; continue; }
    }
    let next = line.length;
    for (const m of ["**", "`", "_"]) {
      const p = line.indexOf(m, i);
      if (p !== -1 && p < next) next = p;
    }
    if (next <= i) next = i + 1;
    flush(i, next);
    i = next;
  }
  return segs;
}

function InlineText({ line }: { line: string }): React.ReactElement {
  return (
    <Text>
      {parseInline(line).map((s, i) => (
        <Text key={i} bold={s.bold} italic={s.italic} color={s.code ? "yellow" : undefined}>{s.text}</Text>
      ))}
    </Text>
  );
}

/** Single non-code line: heading, list item, or inline text. */
function MdLine({ line }: { line: string }): React.ReactElement {
  const h = line.match(/^(#{1,6})\s+(.*)/);
  if (h) return <Text bold color="cyan">{h[2]}</Text>;
  const li = line.match(/^(\s*)[-*+]\s+(.*)/);
  if (li) return <Box><Text>{li[1]}• </Text><InlineText line={li[2]} /></Box>;
  return <InlineText line={line} />;
}

// Common keywords (multi-language) for light syntax coloring.
const KEYWORDS = new Set([
  "function", "const", "let", "var", "return", "if", "else", "for", "while", "class", "new",
  "public", "private", "protected", "static", "void", "int", "string", "bool", "async", "await",
  "import", "export", "from", "using", "namespace", "interface", "type", "enum", "extends", "implements",
  "def", "self", "None", "True", "False", "null", "true", "false", "this",
]);

/** Very light generic syntax coloring: strings, comments, numbers, keywords. */
function highlightCode(line: string): React.ReactElement {
  // Comment (// … or # …) → the rest of the line is dim.
  const cm = line.match(/(\/\/|#).*/);
  const codePart = cm ? line.slice(0, cm.index) : line;
  const commentPart = cm ? line.slice(cm.index) : "";
  const tokens = codePart.split(/(\s+|[(){}\[\].,;:]|"[^"]*"|'[^']*')/).filter((t) => t !== "");
  return (
    <Text>
      {tokens.map((t, i) => {
        let color: string | undefined;
        if (/^".*"$|^'.*'$/.test(t)) color = "green";
        else if (/^\d+(\.\d+)?$/.test(t)) color = "yellow";
        else if (KEYWORDS.has(t)) color = "magenta";
        return <Text key={i} color={color}>{t}</Text>;
      })}
      {commentPart ? <Text dimColor>{commentPart}</Text> : null}
    </Text>
  );
}

/** Code block: language label + line-number gutter + light syntax coloring (editor style, borderless). */
function CodeBlock({ lang, lines }: { lang: string; lines: string[] }): React.ReactElement {
  const gutter = String(Math.max(1, lines.length)).length;
  return (
    <Box flexDirection="column" marginTop={1}>
      {lang ? <Text color="magenta" dimColor>{`╭─ ${lang}`}</Text> : null}
      {lines.map((l, i) => (
        <Box key={i}>
          <Text dimColor>{`${String(i + 1).padStart(gutter, " ")} │ `}</Text>
          {highlightCode(l)}
        </Box>
      ))}
    </Box>
  );
}

/** Block + inline markdown: headings, lists, code fences (editor-style), bold/code/italic. */
export function Markdown({ text }: { text: string }): React.ReactElement {
  const lines = text.split("\n");
  const blocks: React.ReactElement[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const fence = lines[i].match(/^\s*```(\w*)/);
    if (fence) {
      const lang = fence[1] || "";
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) { code.push(lines[i]); i++; }
      i++; // skip closing fence
      blocks.push(<CodeBlock key={key++} lang={lang} lines={code} />);
      continue;
    }
    blocks.push(<MdLine key={key++} line={lines[i]} />);
    i++;
  }
  return <Box flexDirection="column">{blocks}</Box>;
}
