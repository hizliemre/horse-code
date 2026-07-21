import React, { useEffect, useState, memo } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import type { BoardCardView } from "../engine/progress.js";
import type { Column } from "../board/board.js";
import type { TuiController } from "./controller.js";
import { HORSE_VARIANTS } from "./horse-art.js";

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

export function InputLine({ onSubmit }: { onSubmit: (s: string) => void }): React.ReactElement {
  const [buf, setBuf] = useState("");
  useInput((input, key) => {
    if (key.return) {
      onSubmit(buf);
      setBuf("");
    } else if (key.backspace || key.delete) {
      setBuf((b) => b.slice(0, -1));
    } else if (input) {
      setBuf((b) => b + input);
    }
  });
  return <Text>{"> "}{buf}</Text>;
}

export function Prompt({ question, onSubmit }: { question: string; onSubmit: (s: string) => void }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>{question}</Text>
      <InputLine onSubmit={onSubmit} />
    </Box>
  );
}

export const Message = memo(function Message({ role, text }: { role: "user" | "assistant"; text: string }): React.ReactElement {
  return role === "user" ? (
    <Text color="gray">{"› "}{text}</Text>
  ) : (
    <Text><Text color="green">{"● "}</Text>{text}</Text>
  );
});

// Kompakt block-font (4-geniş harf) → daha küçük wordmark.
const GLYPHS: Record<string, string[]> = {
  H: ["█  █", "█  █", "████", "█  █", "█  █"],
  O: ["████", "█  █", "█  █", "█  █", "████"],
  R: ["███ ", "█  █", "███ ", "█ █ ", "█  █"],
  S: ["████", "█   ", "████", "   █", "████"],
  E: ["████", "█   ", "███ ", "█   ", "████"],
  C: ["████", "█   ", "█   ", "█   ", "████"],
  D: ["███ ", "█  █", "█  █", "█  █", "███ "],
  " ": ["  ", "  ", "  ", "  ", "  "],
};
const WORDMARK: string[] = [0, 1, 2, 3, 4].map((r) =>
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

export const Splash = memo(function Splash({ cols, rows }: { cols: number; rows: number }): React.ReactElement {
  const topMargin = 2; // logonun üstünde boşluk
  const bottomMargin = 1; // logonun altında boşluk
  const inputArea = 6; // ipucu + kenarlıklı kutu + margin
  const showWordmark = cols >= WM_WIDTH + 2 && rows >= 24;
  const wordmarkH = showWordmark ? 6 : 0;
  const budget = rows - inputArea - wordmarkH - topMargin - bottomMargin; // logo için kalan satır
  // Bütçeye + genişliğe sığan EN BÜYÜK varyant; hiçbiri sığmazsa logo gizle (taşma/iz olmasın).
  let variant: (typeof HORSE_VARIANTS)[number] | undefined;
  for (let i = HORSE_VARIANTS.length - 1; i >= 0; i--) {
    if (HORSE_VARIANTS[i].rows <= budget && HORSE_VARIANTS[i].cols + 2 <= cols) {
      variant = HORSE_VARIANTS[i];
      break;
    }
  }
  return (
    <Box width={cols} flexDirection="column" alignItems="center" marginTop={topMargin} marginBottom={bottomMargin}>
      {variant ? (
        <Box flexDirection="column">
          {variant.art.map((segs, y) => (
            <Box key={y}>
              {segs.map((s, i) => (
                <Text key={i} color={s.fg} backgroundColor={s.bg}>{s.text}</Text>
              ))}
            </Box>
          ))}
        </Box>
      ) : null}
      {showWordmark ? (
        <Box flexDirection="column" marginTop={variant ? 1 : 0}>
          {WM_ROWS.map((segs, y) => (
            <Box key={y}>
              {segs.map((s, i) => (
                <Text key={i} color={s.color} bold>{s.text}</Text>
              ))}
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
});

export function App({ controller }: { controller: TuiController }): React.ReactElement {
  const [state, setState] = useState(controller.getState());
  useEffect(() => controller.subscribe(() => setState(controller.getState())), [controller]);
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    cols: stdout && stdout.columns ? stdout.columns : 80,
    rows: stdout && stdout.rows ? stdout.rows : 24,
  });
  const [resizing, setResizing] = useState(false);
  // Resize debounce: sürükleme boyunca boş göster (flicker/artefakt yok), durunca baştan render et.
  useEffect(() => {
    if (!stdout || typeof stdout.on !== "function") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = (): void => {
      setResizing(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (typeof stdout.write === "function") stdout.write("\x1b[2J\x1b[3J\x1b[H"); // ekran+scrollback temizle → iz kalmaz
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

  if (resizing) return <Box />; // resize sırasında ekran boş → bitince temiz baştan render
  const mode = state.mode ?? "running";
  return (
    <Box flexDirection="column">
      <Splash cols={size.cols} rows={size.rows} />
      {state.transcript.map((m, i) => (
        <Message key={i} role={m.role} text={m.text} />
      ))}
      {mode === "input" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Görevini yaz — Enter gönder · Ctrl+C çıkış</Text>
          <Box borderStyle="round" borderColor="gray" paddingX={1}>
            <InputLine onSubmit={(t) => controller.submitTask(t)} />
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          <PhaseBar phase={state.phase} detail={state.detail} />
          <Board cards={state.cards} />
          {state.pending ? <Prompt question={state.pending.question} onSubmit={(s) => controller.answer(s)} /> : null}
        </Box>
      )}
    </Box>
  );
}
