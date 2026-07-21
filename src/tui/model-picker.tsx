import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useStdin } from "ink";
import { parseKittyKey } from "./keys.js";

const VISIBLE = 10;

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

  const start = Math.max(0, Math.min(sel - Math.floor(VISIBLE / 2), Math.max(0, filtered.length - VISIBLE)));
  const windowed = filtered.slice(start, start + VISIBLE);
  const w = Math.max(10, cols - 2);
  return (
    <Box flexDirection="column" width={w}>
      <Text bold>{`Select model · current: ${current}`}</Text>
      {loading ? (
        <Text dimColor>Loading models…</Text>
      ) : error ? (
        <Text color="red">{`Couldn't fetch models: ${error} · Esc to cancel`}</Text>
      ) : (
        <>
          <Text color="cyan">{`> ${filter}`}</Text>
          {windowed.map((m, i) => {
            const isSel = start + i === sel;
            return (
              <Text key={m} inverse={isSel} wrap="truncate-end">{`${isSel ? "▶ " : "  "}${m}`}</Text>
            );
          })}
          <Text dimColor>↑/↓ move · Enter apply · Esc cancel</Text>
        </>
      )}
    </Box>
  );
}
