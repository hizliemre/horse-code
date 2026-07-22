import React, { useEffect, useState, useRef, memo } from "react";
import { Box, Text, useStdout, useStdin, Static } from "ink";
import type { BoardCardView } from "../engine/progress.js";
import type { Column } from "../board/board.js";
import type { TuiController } from "./controller.js";
import { ProgressView } from "./progress-view.js";
import { donePhrase } from "./labels.js";
import { fmtDuration } from "./format.js";
import { Markdown } from "./markdown.js";
import type { TurnMeta, RunningAgent } from "./controller.js";
import type { StyledLine } from "./lines.js";
import { flattenSplash, flattenMessage, flattenMarkdown } from "./lines.js";
import { ModelPicker, PICKER_HEIGHT } from "./model-picker.js";
import { parseKittyKey } from "./keys.js";
import { matchCommands, helpText, type SlashCommand } from "./commands.js";

const COLUMNS: Column[] = ["TODO", "IN-PROGRESS", "REVIEW", "DONE"];

/** Splits a pending prompt into its kind + clean body (terminal.ts tags them "[question]"/"[permission]"/"[human]"). */
export function parsePending(raw: string): { kind: "question" | "permission" | "human"; body: string } {
  const t = raw.replace(/^\s+/, "");
  const m = t.match(/^\[(question|permission|human)\]\s*/);
  if (m) return { kind: m[1] as "question" | "permission" | "human", body: t.slice(m[0].length).trim() };
  return { kind: "question", body: t.trim() };
}

const PENDING_STYLE = {
  question: { icon: "?", label: "Question", color: "yellow" as const },
  permission: { icon: "⚠", label: "Permission", color: "red" as const },
  human: { icon: "◆", label: "Review", color: "cyan" as const },
};

/** Width of the pending-question body (shared by the renderer + the fullscreen height math → same wrap → same line count). */
export function pendingWidth(cols: number): number {
  return Math.max(20, cols - 2);
}

/**
 * Renders a pending question/permission/review prompt: a colored icon + label header, then the body
 * rendered as markdown (bold/lists/code) — the body often contains a markdown-formatted numbered list.
 */
export function PendingQuestion({ text, cols }: { text: string; cols: number }): React.ReactElement {
  const { kind, body } = parsePending(text);
  const s = PENDING_STYLE[kind];
  const width = pendingWidth(cols);
  const lines = flattenMarkdown(body, width);
  return (
    <Box flexDirection="column" width={width}>
      <Text color={s.color} bold>{`${s.icon} ${s.label}`}</Text>
      {lines.map((line, i) => (
        <Text key={i}>
          {line.length === 0 ? " " : line.map((seg, j) => (
            <Text key={j} color={seg.color} backgroundColor={seg.backgroundColor} bold={seg.bold} italic={seg.italic} dimColor={seg.dim}>{seg.text}</Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}

/** Slash-command palette shown above the input when the draft starts with "/". */
export function SlashPalette({ commands, selected, cols }: { commands: SlashCommand[]; selected: number; cols: number }): React.ReactElement {
  const w = Math.max(24, cols - 2);
  return (
    <Box flexDirection="column" width={w} borderStyle="round" borderColor="cyan" paddingX={1}>
      {commands.map((c, i) => {
        const isSel = i === selected;
        return (
          <Text key={c.name} wrap="truncate-end">
            <Text color={isSel ? "cyan" : undefined} inverse={isSel} bold={isSel}>{`${isSel ? "› " : "  "}${c.name}`}</Text>
            <Text dimColor>{`  ${c.desc}`}</Text>
          </Text>
        );
      })}
      <Text dimColor wrap="truncate-end">{"↑/↓ select · Enter run · → complete · Esc cancel"}</Text>
    </Box>
  );
}

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
  return <Text>Phase: {phase}{detail ? ` — ${detail}` : ""}</Text>;
}

/**
 * One-line model indicator under the input — always the coach model (never the last call's model, so it
 * doesn't flip to the refiner mid-refine). Duration + tokens live next to the status verb above the input;
 * this line stays a compact 1-row model badge. `wrap="truncate-end"` keeps it a single row.
 */
export function MetricsLine({ meta, model }: { meta: TurnMeta; model?: string }): React.ReactElement {
  const shown = model || meta.model || "—";
  return <Text dimColor wrap="truncate-end">{`  ${shown}`}</Text>;
}

/**
 * Live panel of the sub-agents currently working tasks (the parallel wave), shown under the input:
 * a count header + one row each — "● <task> · <elapsed> · <model>". The elapsed time ticks locally.
 */
export function RunningAgents({ agents, cols }: { agents: RunningAgent[]; cols: number }): React.ReactElement {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);
  const width = Math.max(20, cols - 2);
  return (
    <Box flexDirection="column" width={width}>
      <Text dimColor>{`  ${agents.length} ${agents.length === 1 ? "agent" : "agents"} running`}</Text>
      {agents.map((a) => {
        const dur = fmtDuration(Date.now() - a.startedAt);
        return (
          <Text key={a.id} wrap="truncate-end">
            <Text color="cyan">{"  ● "}</Text>
            {a.title}
            <Text dimColor>{`  · ${dur}${a.model ? ` · ${a.model}` : ""}`}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

// Sequences counted as newline (do NOT submit): plain LF, Alt+Enter (ESC+CR/LF), and the known
// escapes terminals send for Shift+Enter (kitty CSI-u, xterm modifyOtherKeys).
const NEWLINE_SEQS = new Set(["\n", "\x1b\r", "\x1b\n", "\x1b[13;2u", "\x1b[27;2;13~"]);

const LEFT = new Set(["\x1b[D", "\x1bOD"]);
const RIGHT = new Set(["\x1b[C", "\x1bOC"]);
const HOME = new Set(["\x1b[H", "\x1b[1~", "\x1bOH"]);
const END = new Set(["\x1b[F", "\x1b[4~", "\x1bOF"]);

// Numpad in application-keypad mode sends SS3 sequences instead of characters (some terminals put the
// numpad in this mode under the alt-screen). Map them back so digits, `.` and `/` can be typed at all.
const NUMPAD: Record<string, string> = {
  "\x1bOp": "0", "\x1bOq": "1", "\x1bOr": "2", "\x1bOs": "3", "\x1bOt": "4",
  "\x1bOu": "5", "\x1bOv": "6", "\x1bOw": "7", "\x1bOx": "8", "\x1bOy": "9",
  "\x1bOn": ".", "\x1bOo": "/", "\x1bOj": "*", "\x1bOk": "+", "\x1bOm": "-",
};

export function InputLine({ value, cursor, onChange, onSubmit, width, paletteOpen = false }: {
  value: string;
  cursor: number;
  onChange: (value: string, cursor: number) => void;
  onSubmit: (value: string) => void;
  width?: number;
  paletteOpen?: boolean; // when the slash palette is open, → is a "complete" gesture owned by App, not a cursor move
}): React.ReactElement {
  // Controlled: state lives in App (draft+cursor) → height is computed synchronously (no flicker on newline).
  const valRef = useRef(value); valRef.current = value;
  const curRef = useRef(cursor); curRef.current = cursor;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const onSubmitRef = useRef(onSubmit); onSubmitRef.current = onSubmit;
  const paletteRef = useRef(paletteOpen); paletteRef.current = paletteOpen;
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  // Raw stdin: Enter(CR) submits; LF/kitty-CSI-u newline; left/right arrow moves the cursor; insert/delete
  // in the middle; Ctrl+C clears if non-empty, exits if empty. Up/down/PgUp go to App's useInput (scroll).
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
      if (RIGHT.has(s)) { if (paletteRef.current) return; change(v, Math.min(v.length, c + 1)); return; }
      if (HOME.has(s)) { change(v, 0); return; }
      if (END.has(s)) { change(v, v.length); return; }
      if (s === "\x1bOM") { onSubmitRef.current(v); return; } // numpad Enter → submit (app-keypad SS3)
      const np = NUMPAD[s];
      if (np) { change(v.slice(0, c) + np + v.slice(c), c + np.length); return; } // numpad char (app-keypad SS3)
      const kk = parseKittyKey(s); // kitty CSI-u numpad (what iTerm2 sends with the protocol enabled)
      if (kk) {
        if (kk.type === "enter") { onSubmitRef.current(v); return; }
        if (kk.type === "char") { change(v.slice(0, c) + kk.char + v.slice(c), c + kk.char.length); return; }
        return; // other CSI-u functional key → ignore
      }
      if (s.startsWith("\x1b")) return; // up/down/PgUp/PgDn → App scroll handler
      if ([...s].every((ch) => ch >= " ")) change(v.slice(0, c) + s + v.slice(c), c + s.length); // insert printable
    };
    stdin.on("data", onData);
    return () => { stdin.off("data", onData); };
  }, [stdin, setRawMode, isRawModeSupported]);

  // Compute the cursor's line/column → render that cell as a reverse-video block (cursor). `>` is always on the first line.
  let cLine = 0, cCol = 0;
  for (let i = 0; i < cursor; i++) { if (value[i] === "\n") { cLine++; cCol = 0; } else cCol++; }
  const lines = value.split("\n");
  return (
    // Explicit width: Ink caches a Text node's intrinsic measured width; jumping the value from short to
    // long in one render (e.g. history recall from empty) keeps the stale narrow width and mis-wraps. Binding
    // the box to a fixed width makes wrapping depend on the box, not the cached measure.
    <Box flexDirection="column" width={width}>
      {lines.map((line, i) => {
        const prefix = i === 0 ? "> " : "  ";
        if (i !== cLine) return <Text key={i}><Text color="cyan">{prefix}</Text>{line}</Text>;
        const atChar = line[cCol] ?? " "; // character under the cursor (space at end of line)
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
  // Hanging-indent + EXPLICIT width (cols - bullet) → Ink wraps word-by-word (not char), lines align with the text.
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

// Compact 3-line block-font (≈40% smaller wordmark).
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

// Color-transitioning + shaded wordmark: horizontal orange→gold gradient, darkens further down the lines.
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
  const topMargin = 2; // space above the wordmark
  const bottomMargin = 1; // space below the wordmark
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

// Fixed-height line window: does NOT RELY on Ink's overflow; manually renders exactly the lines
// that fit (no garbling). Empty lines are padded at the top so content stays bottom-aligned.
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

export function App({ controller, fullscreen = false, model, coachModel, refinerModel, listModels, setModel, onExit }: {
  controller: TuiController;
  fullscreen?: boolean;
  model?: string;
  coachModel?: string; // the coach's model — always shown in the metrics line under the input
  refinerModel?: string; // the refiner's model — shown only in the "refining… (model)" status line
  listModels?: () => Promise<string[]>;
  setModel?: (m: string) => void;
  onExit?: () => void; // /exit → restore the terminal and quit (wired by runTuiRepl)
}): React.ReactElement {
  const [state, setState] = useState(controller.getState());
  useEffect(() => controller.subscribe(() => setState(controller.getState())), [controller]);
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    cols: stdout && stdout.columns ? stdout.columns : 80,
    rows: stdout && stdout.rows ? stdout.rows : 24,
  });
  const [resizing, setResizing] = useState(false);
  // Resize debounce: clear the dynamic input while dragging (no flicker), update the size once it settles.
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

  // Fullscreen: inner-scroll offset (how many lines up from the bottom). Jumps back to the bottom on a new message/phase.
  const [scroll, setScroll] = useState(0);
  const [draft, setDraft] = useState(""); // main input buffer (in App → height computed synchronously)
  const [draftCursor, setDraftCursor] = useState(0);
  const maxScrollRef = useRef(0); // updated during render → used by the handler for clamping
  // Command history (like a shell): ↑ previous prompt, ↓ returns to the unsent draft.
  const draftRef = useRef("");
  draftRef.current = draft;
  const historyRef = useRef<string[]>([]); // submitted prompts (oldest to newest)
  const histIdxRef = useRef(-1);            // -1 = draft (not navigating); otherwise the history index
  const stashRef = useRef("");              // draft stashed when ↑ is pressed → restored with ↓
  const setInput = (v: string): void => { setDraft(v); setDraftCursor(v.length); };
  const historyPrev = (): void => {
    const h = historyRef.current;
    if (h.length === 0) return;
    if (histIdxRef.current === -1) { stashRef.current = draftRef.current; histIdxRef.current = h.length - 1; }
    else if (histIdxRef.current > 0) { histIdxRef.current -= 1; }
    else return; // already at the oldest
    setInput(h[histIdxRef.current]);
  };
  const historyNext = (): void => {
    if (histIdxRef.current === -1) return; // not navigating
    const h = historyRef.current;
    if (histIdxRef.current < h.length - 1) { histIdxRef.current += 1; setInput(h[histIdxRef.current]); }
    else { histIdxRef.current = -1; setInput(stashRef.current); } // return to draft (empty if it was empty)
  };
  // Slash-command palette: open when the input-mode draft starts with "/" and matches ≥1 command.
  const [slashSel, setSlashSel] = useState(0);
  const slashCmds = matchCommands(draft);
  const slashOpen = (state.mode ?? "running") === "input" && !state.pending && draft.startsWith("/") && slashCmds.length > 0;
  const slashIdx = Math.min(slashSel, Math.max(0, slashCmds.length - 1));
  const completeSlash = (): void => { const c = slashCmds[slashIdx]; if (c) { setDraft(c.name); setDraftCursor(c.name.length); } };
  const runSlash = (c: SlashCommand): void => {
    setScroll(0); setDraft(""); setDraftCursor(0); setSlashSel(0);
    if (c.name === "/model") controller.openPicker();
    else if (c.name === "/help") controller.note(helpText());
    else if (c.name === "/clear") controller.clearTranscript();
    else if (c.name === "/exit") onExit?.();
    else if (
      c.name === "/constitution" ||
      c.name === "/specify" ||
      c.name === "/clarify" ||
      c.name === "/plan" ||
      c.name === "/tasks"
    ) controller.submitTask(c.name);
  };
  const tlen = state.transcript.length;
  useEffect(() => { setScroll(0); }, [tlen]);
  // When the picker opens (loading), fetch the model list once and hand it to the controller.
  useEffect(() => {
    if (state.mode === "picker" && state.picker?.loading && listModels) {
      let cancelled = false;
      listModels().then(
        (models) => { if (!cancelled) controller.setPickerModels(models); },
        (e) => { if (!cancelled) controller.setPickerError(e instanceof Error ? e.message : String(e)); },
      );
      return () => { cancelled = true; };
    }
    return undefined;
  }, [state.mode, state.picker?.loading, listModels, controller]);
  // Scroll / command-history keys via RAW stdin instead of Ink's useInput. Ink's parseKeypress can
  // yield an undefined `sequence` for some keys (e.g. numpad in application-keypad mode), then
  // `input.startsWith('')` throws and crashes the app. Parsing the few sequences we care about
  // ourselves and ignoring the rest sidesteps that entirely.
  const { stdin: rootStdin } = useStdin();
  const keyRef = useRef<(s: string) => void>(() => {});
  keyRef.current = (s: string): void => {
    if (!fullscreen || state.mode === "picker") return;
    const isInput = (state.mode ?? "running") === "input";
    const up = s === "\x1b[A" || s === "\x1bOA";
    const down = s === "\x1b[B" || s === "\x1bOB";
    const pgUp = s === "\x1b[5~";
    const pgDn = s === "\x1b[6~";
    // Slash palette owns ↑/↓ (select), →/Tab (complete), Esc (cancel) while it's open.
    if (slashOpen) {
      if (up) { setSlashSel((n) => Math.max(0, n - 1)); return; }
      if (down) { setSlashSel((n) => Math.min(slashCmds.length - 1, n + 1)); return; }
      if (RIGHT.has(s) || s === "\t") { completeSlash(); return; }
      const kk = parseKittyKey(s);
      if (s === "\x1b" || kk?.type === "escape") { setDraft(""); setDraftCursor(0); return; }
    }
    // In input mode ↑/↓ is command history; transcript scrolls via PgUp/PgDn. In job mode ↑/↓ scrolls.
    if (isInput && up) { historyPrev(); return; }
    if (isInput && down) { historyNext(); return; }
    const page = Math.max(1, size.rows - 8);
    const m = maxScrollRef.current;
    if (up) setScroll((v) => Math.min(m, v + 1));
    else if (down) setScroll((v) => Math.max(0, v - 1));
    else if (pgUp) setScroll((v) => Math.min(m, v + page));
    else if (pgDn) setScroll((v) => Math.max(0, v - page));
  };
  useEffect(() => {
    if (!rootStdin || !fullscreen) return undefined;
    const onData = (chunk: Buffer | string): void => {
      keyRef.current(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    };
    rootStdin.on("data", onData);
    return () => { rootStdin.off("data", onData); };
  }, [rootStdin, fullscreen]);

  const mode = state.mode ?? "running";
  const bottom =
    mode === "input" ? (
      <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={1} width={size.cols} flexShrink={0}>
        <InputLine
          value={draft}
          cursor={draftCursor}
          width={Math.max(1, size.cols - 4)}
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
        <ProgressView phase={state.phase} detail={state.detail} refinerModel={refinerModel} meta={state.meta} cols={size.cols} />
        <Board cards={state.cards} />
        {state.pending ? <Prompt question={state.pending.question} onSubmit={(s) => controller.answer(s)} /> : null}
      </Box>
    );

  // Fullscreen (Claude Code model): flatten content into plain styled lines → manually render the
  // exactly-fitting window (no Ink overflow bug). The input is ALWAYS visible at the bottom; while a job
  // runs, a cyan status box sits above it and a metrics line below it. ↑/↓/PgUp/PgDn scrolls history.
  if (fullscreen) {
    const allLines: StyledLine[] = [
      ...flattenSplash(size.cols, size.rows),
      ...state.transcript.flatMap((m) => flattenMessage(m.role, m.text, size.cols)),
    ];
    if (state.mode === "picker") {
      const PICKER_H = PICKER_HEIGHT + 1; // the ModelPicker box + its marginTop (deterministic)
      const viewportH = Math.max(3, size.rows - PICKER_H - 1);
      const maxScroll = Math.max(0, allLines.length - viewportH);
      maxScrollRef.current = maxScroll;
      const clamped = Math.min(scroll, maxScroll);
      const end = allLines.length - clamped;
      const win = allLines.slice(Math.max(0, end - viewportH), end);
      return (
        <Box flexDirection="column" height={size.rows}>
          <ViewportLines lines={win} height={viewportH} />
          <Text dimColor> </Text>
          <Box marginTop={1}>
            <ModelPicker
              models={state.picker?.models ?? []}
              current={state.currentModel || model || "—"}
              loading={state.picker?.loading ?? false}
              error={state.picker?.error}
              cols={size.cols}
              onSelect={(m) => { setModel?.(m); controller.applyModel(m); }}
              onCancel={() => controller.cancelPicker()}
            />
          </Box>
        </Box>
      );
    }
    const cw = Math.max(1, size.cols - 4);
    const inputH = draft.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil((l.length + 3) / cw)), 0);
    const running = mode === "running";
    // While a question is pending the job is blocked waiting for the user → hide the "refining…" status
    // (it would keep ticking as if working). Show the running status only when nothing is pending.
    const progressLine = running && !state.pending;
    // After a turn finishes, the running status is replaced by a static "zottired for 1m 23s" completion line.
    const doneLine = !!state.meta && !state.meta.running && !state.pending;
    const showStatus = progressLine || !!state.pending || doneLine;
    // Status lines sit directly above the input (no box, no gap). Height is deterministic → no Ink overflow.
    const boardLines = showStatus && state.cards.length
      ? 1 + Math.max(...COLUMNS.map((col) => state.cards.filter((c) => c.column === col).length))
      : 0;
    // Pending prompt: 1 header line + the markdown-flattened body lines (same width as PendingQuestion → same count).
    const pendingLines = state.pending
      ? 1 + flattenMarkdown(parsePending(state.pending.question).body, pendingWidth(size.cols)).length
      : 0;
    const statusH = (progressLine || doneLine ? 1 : 0) + boardLines + pendingLines; // progress/done(1) + board + pending
    const inputMarginTop = showStatus ? 0 : 1; // no blank line between the status label and the input
    const inputBoxH = 2 + inputMarginTop + inputH; // border(2) + marginTop + inputH
    const metricsH = state.meta ? 1 : 0;
    const metricsGapH = state.meta ? 1 : 0; // small blank line below the info line
    const queuedH = state.queued > 0 ? 1 : 0;
    // Live-agents panel under the input: 1 header line + one row per running sub-agent.
    const agentsH = state.runningAgents.length > 0 ? 1 + state.runningAgents.length : 0;
    const paletteH = slashOpen ? slashCmds.length + 3 : 0; // border(2) + command rows + hint(1)
    const bottomH = statusH + paletteH + inputBoxH + metricsH + queuedH + metricsGapH + agentsH;
    const viewportH = Math.max(3, size.rows - bottomH - 1); // -1: scroll hint line
    const maxScroll = Math.max(0, allLines.length - viewportH);
    maxScrollRef.current = maxScroll;
    const clamped = Math.min(scroll, maxScroll);
    const end = allLines.length - clamped;
    const windowed = allLines.slice(Math.max(0, end - viewportH), end);
    return (
      <Box flexDirection="column" height={size.rows}>
        <ViewportLines lines={windowed} height={viewportH} />
        <Text dimColor>{clamped > 0 ? `  ↓ ${clamped} more · ↓/PgDn to jump to bottom` : " "}</Text>
        {showStatus ? (
          <Box flexDirection="column">
            {progressLine ? <Box paddingLeft={2}><ProgressView phase={state.phase} detail={state.detail} refinerModel={refinerModel} meta={state.meta} cols={size.cols} /></Box> : null}
            {doneLine ? <Box paddingLeft={2}><Text dimColor>{`${donePhrase(state.phase)} for ${fmtDuration(state.meta?.durationMs ?? 0)}`}</Text></Box> : null}
            {boardLines ? <Board cards={state.cards} /> : null}
            {state.pending ? <PendingQuestion text={state.pending.question} cols={size.cols} /> : null}
          </Box>
        ) : null}
        {slashOpen ? <SlashPalette commands={slashCmds} selected={slashIdx} cols={size.cols} /> : null}
        <Box marginTop={inputMarginTop} borderStyle="round" borderColor={state.pending ? "yellow" : "gray"} paddingX={1} width={size.cols} flexShrink={0}>
          <InputLine
            value={draft}
            cursor={draftCursor}
            width={cw}
            paletteOpen={slashOpen}
            onChange={(v, c) => { if (v !== draftRef.current) histIdxRef.current = -1; setDraft(v); setDraftCursor(c); setSlashSel(0); }}
            onSubmit={(t) => {
              // Pending approval question → the answer routes to controller.answer (single input, no modal).
              if (state.pending) { setScroll(0); setDraft(""); setDraftCursor(0); controller.answer(t); return; }
              // Slash palette open → Enter runs the selected command instead of submitting a prompt.
              if (slashOpen) { const c = slashCmds[slashIdx]; if (c) { runSlash(c); return; } }
              if (t.trim()) historyRef.current = [...historyRef.current, t];
              histIdxRef.current = -1; stashRef.current = "";
              setScroll(0); setDraft(""); setDraftCursor(0); controller.submitTask(t);
            }}
          />
        </Box>
        {state.meta ? <MetricsLine meta={state.meta} model={state.currentModel || coachModel || model} /> : null}
        {state.runningAgents.length > 0 ? <RunningAgents agents={state.runningAgents} cols={size.cols} /> : null}
        {state.queued > 0 ? <Text dimColor>{`  ${state.queued} queued`}</Text> : null}
        {state.meta ? <Text> </Text> : null}
      </Box>
    );
  }

  // One-shot (hcode "<prompt>"): <Static> layout — normal terminal, scrollback.
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
