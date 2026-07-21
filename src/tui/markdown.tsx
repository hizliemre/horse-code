import React from "react";
import { Box, Text } from "ink";

export interface InlineSeg {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

/** Satır-içi markdown: **kalın**, `kod`, _italik_. */
export function parseInline(line: string): InlineSeg[] {
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
    // Sonraki işaretçiye kadar düz metin.
    let next = line.length;
    for (const m of ["**", "`", "_"]) {
      const p = line.indexOf(m, i);
      if (p !== -1 && p < next) next = p;
    }
    if (next <= i) next = i + 1; // sonsuz döngü koruması
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

/** Blok + satır-içi markdown render (başlık, liste, kod-bloğu, kalın/kod/italik). */
export function Markdown({ text }: { text: string }): React.ReactElement {
  const lines = text.split("\n");
  const out: React.ReactElement[] = [];
  let inCode = false;
  lines.forEach((line, idx) => {
    if (line.trim().startsWith("```")) { inCode = !inCode; return; } // fence satırını gizle
    if (inCode) { out.push(<Text key={idx} color="gray">{line}</Text>); return; }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) { out.push(<Text key={idx} bold color="cyan">{h[2]}</Text>); return; }
    const li = line.match(/^(\s*)[-*+]\s+(.*)/);
    if (li) {
      out.push(<Box key={idx}><Text>{li[1]}• </Text><InlineText line={li[2]} /></Box>);
      return;
    }
    out.push(<InlineText key={idx} line={line} />);
  });
  return <Box flexDirection="column">{out}</Box>;
}
