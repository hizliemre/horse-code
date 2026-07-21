import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useStdin } from "ink";
import { parseKittyKey } from "./keys.js";

const VISIBLE = 8;
// Total rows the picker occupies (for the fullscreen height reservation in App):
// border(2) + header(1) + filter(1) + scroll-up(1) + VISIBLE + scroll-down(1) + hint(1).
export const PICKER_HEIGHT = VISIBLE + 7;

export function ModelPicker({ models, current, loading, error, cols, onSelect, onCancel }: {
  models: string[];
  current: string;
  loading: boolean;
  error?: string;
  cols: number;
  onSelect: (model: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const filtered = models.filter((m) => m.toLowerCase().includes(filter.toLowerCase()));
  const sel = Math.min(selected, Math.max(0, filtered.length - 1));

  // refs so the raw-stdin handler always sees current values without re-subscribing
  const stRef = useRef({ filtered, sel, loading, error });
  stRef.current = { filtered, sel, loading, error };
  const cbRef = useRef({ onSelect, onCancel });
  cbRef.current = { onSelect, onCancel };

  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  useEffect(() => {
    if (!stdin) return;
    if (isRawModeSupported && setRawMode) setRawMode(true);
    const onData = (chunk: Buffer | string): void => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const st = stRef.current, cb = cbRef.current;
      const kk = parseKittyKey(s); // kitty CSI-u (iTerm2 with the protocol) → numpad chars, Enter, Esc
      if (s === "\x1b" || kk?.type === "escape") { cb.onCancel(); return; } // Esc (legacy or kitty)
      if (st.loading || st.error) return; // only Esc works while loading / on error
      if (s === "\x1b[A" || s === "\x1bOA") { setSelected((n) => Math.max(0, n - 1)); return; }
      if (s === "\x1b[B" || s === "\x1bOB") { setSelected((n) => Math.min(st.filtered.length - 1, n + 1)); return; }
      if (s === "\r" || kk?.type === "enter") { const m = st.filtered[st.sel]; if (m) cb.onSelect(m); return; }
      if (s === "\x7f" || s === "\x08") { setFilter((f) => f.slice(0, -1)); setSelected(0); return; }
      if (kk?.type === "char") { setFilter((f) => f + kk.char); setSelected(0); return; } // kitty numpad char
      if (kk) return; // other kitty functional key → ignore
      if (s.startsWith("\x1b")) return; // ignore other escape sequences
      if ([...s].every((ch) => ch >= " ")) { setFilter((f) => f + s); setSelected(0); }
    };
    stdin.on("data", onData);
    return () => { stdin.off("data", onData); };
  }, [stdin, setRawMode, isRawModeSupported]);

  const total = models.length;
  const start = Math.max(0, Math.min(sel - Math.floor(VISIBLE / 2), Math.max(0, filtered.length - VISIBLE)));
  const windowed = filtered.slice(start, start + VISIBLE);
  const above = start;
  const below = Math.max(0, filtered.length - (start + VISIBLE));
  const w = Math.max(24, cols - 2);
  // Blank filler rows so the body is always VISIBLE tall (no visual drift as the list shrinks).
  const filler = Array.from({ length: Math.max(0, VISIBLE - windowed.length) }, (_, i) => (
    <Text key={`f${i}`}> </Text>
  ));
  // Body: while loading/error, a message centered in the VISIBLE band; otherwise the list.
  const body = loading
    ? [<Text key="l" dimColor>{"  Loading models…"}</Text>, ...Array.from({ length: VISIBLE - 1 }, (_, i) => <Text key={`lp${i}`}> </Text>)]
    : error
      ? [<Text key="e" color="red" wrap="truncate-end">{`  Couldn't fetch models: ${error}`}</Text>, ...Array.from({ length: VISIBLE - 1 }, (_, i) => <Text key={`ep${i}`}> </Text>)]
      : filtered.length === 0
        ? [<Text key="n" dimColor>{`  (no models match "${filter}")`}</Text>, ...Array.from({ length: VISIBLE - 1 }, (_, i) => <Text key={`np${i}`}> </Text>)]
        : [
            ...windowed.map((m, i) => {
              const isSel = start + i === sel;
              return (
                <Text key={m} color={isSel ? "cyan" : undefined} inverse={isSel} wrap="truncate-end">
                  {`${isSel ? "› " : "  "}${m}`}
                </Text>
              );
            }),
            ...filler,
          ];
  return (
    <Box flexDirection="column" width={w} height={PICKER_HEIGHT} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold wrap="truncate-end">{`━━ Select model ━━  ${loading || error ? "" : `${filtered.length}/${total}`}`}</Text>
      <Text wrap="truncate-end">
        <Text color="cyan">{"filter: "}</Text>{filter}<Text inverse>{" "}</Text>
        <Text dimColor>{`   current: ${current}`}</Text>
      </Text>
      <Text dimColor>{above > 0 ? `  ▲ ${above} more` : " "}</Text>
      {body}
      <Text dimColor>{below > 0 ? `  ▼ ${below} more` : " "}</Text>
      <Text dimColor wrap="truncate-end">{"↑/↓ select · Enter apply · Esc cancel · type to filter"}</Text>
    </Box>
  );
}
