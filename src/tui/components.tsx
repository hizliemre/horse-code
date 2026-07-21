import React, { useEffect, useState, useRef, memo } from "react";
import { Box, Text, useInput, useStdout, useStdin, Static } from "ink";
import type { BoardCardView } from "../engine/progress.js";
import type { Column } from "../board/board.js";
import type { TuiController } from "./controller.js";
import { ProgressView } from "./progress-view.js";
import { Markdown } from "./markdown.js";
import type { StyledLine } from "./lines.js";
import { flattenSplash, flattenMessage } from "./lines.js";

const COLUMNS: Column[] = ["TODO", "IN-PROGRESS", "REVIEW", "DONE"];

export function Board({ cards }: { cards: BoardCardView[] }): React.ReactElement {
  return (
    <Box>
      {COLUMNS.map((col) => (
        <Box key={col} flexDirection="column" marginRight={2}>
          <Text bold>{col}</Text>
          {cards.filter((c) => c.column === col).map((c) => (
            <Text key={c.id}>{c.title}</Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}

export function PhaseBar({ phase, detail }: { phase: string; detail?: string }): React.ReactElement {
  return <Text>Faz: {phase}{detail ? ` — ${detail}` : ""}</Text>;
}

// Yeni-satır (submit ETMEZ) sayılan diziler: düz LF, Alt+Enter (ESC+CR/LF) ve terminallerin
// Shift+Enter için yolladığı bilinen escape'ler (kitty CSI-u, xterm modifyOtherKeys).
const NEWLINE_SEQS = new Set(["\n", "\x1b\r", "\x1b\n", "\x1b[13;2u", "\x1b[27;2;13~"]);

const LEFT = new Set(["\x1b[D", "\x1bOD"]);
const RIGHT = new Set(["\x1b[C", "\x1bOC"]);
const HOME = new Set(["\x1b[H", "\x1b[1~", "\x1bOH"]);
const END = new Set(["\x1b[F", "\x1b[4~", "\x1bOF"]);

export function InputLine({ value, cursor, onChange, onSubmit }: {
  value: string;
  cursor: number;
  onChange: (value: string, cursor: number) => void;
  onSubmit: (value: string) => void;
}): React.ReactElement {
  // Kontrollü: state App'te (draft+cursor) → yükseklik senkron hesaplanır (newline'da flick yok).
  const valRef = useRef(value); valRef.current = value;
  const curRef = useRef(cursor); curRef.current = cursor;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const onSubmitRef = useRef(onSubmit); onSubmitRef.current = onSubmit;
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  // Ham stdin: Enter(CR) submit; LF/kitty-CSI-u yeni satır; sol/sağ ok imleç; ortadan ekleme/silme;
  // Ctrl+C doluysa temizle boşsa çık. Yukarı/aşağı/PgUp App useInput'a (scroll).
  useEffect(() => {
    if (!stdin) return;
    if (isRawModeSupported && setRawMode) setRawMode(true);
    const onData = (chunk: Buffer | string): void => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const v = valRef.current, c = curRef.current, change = onChangeRef.current;
      if (s === "\x03" || s === "\x1b[99;5u") { if (v.length > 0) change("", 0); else process.exit(0); return; }
      if (s === "\r") { onSubmitRef.current(v); return; }
      if (NEWLINE_SEQS.has(s)) { change(v.slice(0, c) + "\n" + v.slice(c), c + 1); return; }
      if (s === "\x7f" || s === "\x08") { if (c > 0) change(v.slice(0, c - 1) + v.slice(c), c - 1); return; }
      if (s === "\x1b[3~") { change(v.slice(0, c) + v.slice(c + 1), c); return; } // delete
      if (LEFT.has(s)) { change(v, Math.max(0, c - 1)); return; }
      if (RIGHT.has(s)) { change(v, Math.min(v.length, c + 1)); return; }
      if (HOME.has(s)) { change(v, 0); return; }
      if (END.has(s)) { change(v, v.length); return; }
      if (s.startsWith("\x1b")) return; // yukarı/aşağı/PgUp/PgDn → App useInput (scroll)
      if ([...s].every((ch) => ch >= " ")) change(v.slice(0, c) + s + v.slice(c), c + s.length); // yazdırılabilir ekle
    };
    stdin.on("data", onData);
    return () => { stdin.off("data", onData); };
  }, [stdin, setRawMode, isRawModeSupported]);

  // İmlecin satır/sütununu hesapla → o hücreyi ters-video blok olarak çiz (cursor). `>` hep üst satırda.
  let cLine = 0, cCol = 0;
  for (let i = 0; i < cursor; i++) { if (value[i] === "\n") { cLine++; cCol = 0; } else cCol++; }
  const lines = value.split("\n");
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        const prefix = i === 0 ? "> " : "  ";
        if (i !== cLine) return <Text key={i}><Text color="cyan">{prefix}</Text>{line}</Text>;
        const atChar = line[cCol] ?? " "; // imleç altındaki karakter (satır sonunda boşluk)
        return (
          <Text key={i}>
            <Text color="cyan">{prefix}</Text>
            {line.slice(0, cCol)}
            <Text inverse>{atChar}</Text>
            {line.slice(cCol + 1)}
          </Text>
        );
      })}
    </Box>
  );
}

export function Prompt({ question, onSubmit }: { question: string; onSubmit: (s: string) => void }): React.ReactElement {
  const [val, setVal] = useState("");
  const [cur, setCur] = useState(0);
  return (
    <Box flexDirection="column">
      <Text>{question}</Text>
      <InputLine value={val} cursor={cur} onChange={(v, c) => { setVal(v); setCur(c); }} onSubmit={(t) => { setVal(""); setCur(0); onSubmit(t); }} />
    </Box>
  );
}

export const Message = memo(function Message({ role, text, cols }: { role: "user" | "assistant"; text: string; cols: number }): React.ReactElement {
  // Hanging-indent + AÇIK genişlik (cols - bullet) → Ink kelime-bazında sarar (char değil), satırlar metinle hizalanır.
  const w = Math.max(20, cols - 3);
  return role === "user" ? (
    <Box marginTop={1}>
      <Text color="gray">{"› "}</Text>
      <Box width={w}><Text color="gray">{text}</Text></Box>
    </Box>
  ) : (
    <Box marginTop={1}>
      <Text color="green">{"● "}</Text>
      <Box width={w} flexDirection="column"><Markdown text={text} /></Box>
    </Box>
  );
});

// Kompakt 3-satır block-font (≈%40 küçük wordmark).
const GLYPHS: Record<string, string[]> = {
  H: ["█  █", "████", "█  █"],
  O: ["████", "█  █", "████"],
  R: ["███ ", "██▄▀", "█  █"],
  S: ["▄███", "▀▀▀▄", "███▀"],
  E: ["████", "███ ", "████"],
  C: ["████", "█   ", "████"],
  D: ["███ ", "█  █", "███ "],
  " ": ["  ", "  ", "  "],
};
const WORDMARK: string[] = [0, 1, 2].map((r) =>
  "HORSE CODE".split("").map((ch) => GLYPHS[ch][r]).join(" "),
);

// Renk-geçişli + gölgeli wordmark: yatay turuncu→altın gradyan, satır aşağı indikçe koyulaşır.
const WM_WIDTH = Math.max(...WORDMARK.map((r) => r.length));
const hx = (a: number[]): string =>
  "#" + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const WM_ROWS: { text: string; color?: string }[][] = WORDMARK.map((line, y) => {
  const shade = 1 - 0.22 * (y / (WORDMARK.length - 1));
  const c1 = [0xff, 0x6a, 0x1a];
  const c2 = [0xff, 0xc6, 0x3a];
  const segs: { text: string; color?: string }[] = [];
  for (let x = 0; x < line.length; x++) {
    const ch = line[x];
    if (ch === " ") {
      const last = segs[segs.length - 1];
      if (last && !last.color) last.text += " ";
      else segs.push({ text: " " });
      continue;
    }
    const t = x / (WM_WIDTH - 1);
    const col = hx([
      (c1[0] + (c2[0] - c1[0]) * t) * shade,
      (c1[1] + (c2[1] - c1[1]) * t) * shade,
      (c1[2] + (c2[2] - c1[2]) * t) * shade,
    ]);
    const last = segs[segs.length - 1];
    if (last && last.color === col) last.text += ch;
    else segs.push({ text: ch, color: col });
  }
  return segs;
});

export const Splash = memo(function Splash({ cols }: { cols: number; rows: number }): React.ReactElement | null {
  const topMargin = 2; // yazının üstünde boşluk
  const bottomMargin = 1; // yazının altında boşluk
  const showWordmark = cols >= WM_WIDTH + 2;
  if (!showWordmark) return null;
  return (
    <Box width={cols} flexDirection="column" alignItems="center" marginTop={topMargin} marginBottom={bottomMargin}>
      <Box flexDirection="column">
        {WM_ROWS.map((segs, y) => (
          <Box key={y}>
            {segs.map((s, i) => (
              <Text key={i} color={s.color} bold>{s.text}</Text>
            ))}
          </Box>
        ))}
      </Box>
    </Box>
  );
});

// Sabit-yükseklikli satır penceresi: Ink'in overflow'una GÜVENMEZ; tam sığan satırları
// manuel render eder (garbling yok). İçerik dibe hizalı olsun diye üste boş satır doldurulur.
function ViewportLines({ lines, height }: { lines: StyledLine[]; height: number }): React.ReactElement {
  const pad = Math.max(0, height - lines.length);
  return (
    <Box flexDirection="column" height={height}>
      {Array.from({ length: pad }, (_, i) => (
        <Text key={`pad${i}`}> </Text>
      ))}
      {lines.map((line, i) => (
        <Text key={i}>
          {line.length === 0 ? (
            " "
          ) : (
            line.map((s, j) => (
              <Text key={j} color={s.color} backgroundColor={s.backgroundColor} bold={s.bold} italic={s.italic} dimColor={s.dim}>
                {s.text}
              </Text>
            ))
          )}
        </Text>
      ))}
    </Box>
  );
}

export function App({ controller, fullscreen = false }: { controller: TuiController; fullscreen?: boolean }): React.ReactElement {
  const [state, setState] = useState(controller.getState());
  useEffect(() => controller.subscribe(() => setState(controller.getState())), [controller]);
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    cols: stdout && stdout.columns ? stdout.columns : 80,
    rows: stdout && stdout.rows ? stdout.rows : 24,
  });
  const [resizing, setResizing] = useState(false);
  // Resize debounce: sürükleme boyunca dinamik input'u boşalt (flicker yok), durunca boyutu güncelle.
  useEffect(() => {
    if (!stdout || typeof stdout.on !== "function") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = (): void => {
      setResizing(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setSize({ cols: stdout.columns, rows: stdout.rows });
        setResizing(false);
      }, 150);
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
      if (timer) clearTimeout(timer);
    };
  }, [stdout]);

  // Fullscreen: iç-scroll offset (dipten kaç satır yukarı). Yeni mesaj/faz gelince en alta dön.
  const [scroll, setScroll] = useState(0);
  const [draft, setDraft] = useState(""); // ana input buffer'ı (App'te → yükseklik senkron hesaplanır)
  const [draftCursor, setDraftCursor] = useState(0);
  const maxScrollRef = useRef(0); // render'da güncellenir → handler clamp için kullanır
  // Komut geçmişi (shell gibi): ↑ önceki prompt, ↓ göndermeden yazılan taslağa döner.
  const draftRef = useRef("");
  draftRef.current = draft;
  const historyRef = useRef<string[]>([]); // gönderilen prompt'lar (eskiden yeniye)
  const histIdxRef = useRef(-1);            // -1 = taslak (gezinmiyor); değilse history indeksi
  const stashRef = useRef("");              // ↑'a basılınca saklanan taslak → ↓ ile geri gelir
  const setInput = (v: string): void => { setDraft(v); setDraftCursor(v.length); };
  const historyPrev = (): void => {
    const h = historyRef.current;
    if (h.length === 0) return;
    if (histIdxRef.current === -1) { stashRef.current = draftRef.current; histIdxRef.current = h.length - 1; }
    else if (histIdxRef.current > 0) { histIdxRef.current -= 1; }
    else return; // en eskideyiz
    setInput(h[histIdxRef.current]);
  };
  const historyNext = (): void => {
    if (histIdxRef.current === -1) return; // gezinmiyoruz
    const h = historyRef.current;
    if (histIdxRef.current < h.length - 1) { histIdxRef.current += 1; setInput(h[histIdxRef.current]); }
    else { histIdxRef.current = -1; setInput(stashRef.current); } // taslağa (boşsa boşa) dön
  };
  const tlen = state.transcript.length;
  useEffect(() => { setScroll(0); }, [tlen]);
  useInput((_input, key) => {
    const isInput = (state.mode ?? "running") === "input";
    // Input mode'da ↑/↓ komut geçmişi; transcript scroll'u PgUp/PgDn ile. Job modunda ↑/↓ scroll.
    if (isInput && key.upArrow) { historyPrev(); return; }
    if (isInput && key.downArrow) { historyNext(); return; }
    const page = Math.max(1, size.rows - 8);
    const m = maxScrollRef.current;
    if (key.upArrow) setScroll((s) => Math.min(m, s + 1));
    else if (key.downArrow) setScroll((s) => Math.max(0, s - 1));
    else if (key.pageUp) setScroll((s) => Math.min(m, s + page));
    else if (key.pageDown) setScroll((s) => Math.max(0, s - page));
  }, { isActive: fullscreen });

  const mode = state.mode ?? "running";
  const bottom =
    mode === "input" ? (
      <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
        <InputLine
          value={draft}
          cursor={draftCursor}
          onChange={(v, c) => { if (v !== draftRef.current) histIdxRef.current = -1; setDraft(v); setDraftCursor(c); }}
          onSubmit={(t) => {
            if (t.trim()) historyRef.current = [...historyRef.current, t];
            histIdxRef.current = -1; stashRef.current = "";
            setScroll(0); setDraft(""); setDraftCursor(0); controller.submitTask(t);
          }}
        />
      </Box>
    ) : (
      <Box flexDirection="column">
        <ProgressView phase={state.phase} detail={state.detail} cols={size.cols} />
        <Board cards={state.cards} />
        {state.pending ? <Prompt question={state.pending.question} onSubmit={(s) => controller.answer(s)} /> : null}
      </Box>
    );

  // Fullscreen (Claude Code modeli): içeriği düz styled-satırlara flatten et → tam sığan pencereyi
  // manuel render et (Ink overflow bug'ı yok). Input dibe SABİT; ↑/↓/PgUp/PgDn ile geçmişe scroll.
  if (fullscreen) {
    const allLines: StyledLine[] = [
      ...flattenSplash(size.cols, size.rows),
      ...state.transcript.flatMap((m) => flattenMessage(m.role, m.text, size.cols)),
    ];
    // input kutusu: kenarlık(2) + marginTop(1) + görsel satır (mantıksal + wrap, draft'tan senkron).
    const cw = Math.max(1, size.cols - 4);
    const inputH = draft.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil((l.length + 3) / cw)), 0);
    const bottomH = mode === "input" ? 3 + inputH : 8;
    const viewportH = Math.max(3, size.rows - bottomH - 1); // -1: scroll ipucu satırı
    const maxScroll = Math.max(0, allLines.length - viewportH);
    maxScrollRef.current = maxScroll;
    const clamped = Math.min(scroll, maxScroll);
    const end = allLines.length - clamped;
    const windowed = allLines.slice(Math.max(0, end - viewportH), end);
    return (
      <Box flexDirection="column" height={size.rows}>
        <ViewportLines lines={windowed} height={viewportH} />
        <Text dimColor>{clamped > 0 ? `  ↓ ${clamped} more · ↓/PgDn to jump to bottom` : " "}</Text>
        {bottom}
      </Box>
    );
  }

  // Tek-shot (hcode "<prompt>"): <Static> layout — normal terminal, scrollback.
  type Item =
    | { kind: "splash"; cols: number; rows: number }
    | { kind: "msg"; role: "user" | "assistant"; text: string; cols: number };
  const items: Item[] = [
    { kind: "splash", cols: size.cols, rows: size.rows },
    ...state.transcript.map((m) => ({ kind: "msg" as const, role: m.role, text: m.text, cols: size.cols })),
  ];
  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item, i) =>
          item.kind === "splash" ? (
            <Splash key={i} cols={item.cols} rows={item.rows} />
          ) : (
            <Message key={i} role={item.role} text={item.text} cols={item.cols} />
          )
        }
      </Static>
      {resizing ? null : bottom}
    </Box>
  );
}
