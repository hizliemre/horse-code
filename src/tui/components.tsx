import React, { useEffect, useState, useRef, memo } from "react";
import { Box, Text, useStdout, useStdin, Static } from "ink";
import type { BoardCardView } from "../engine/progress.js";
import type { Column } from "../board/board.js";
import type { TuiController } from "./controller.js";
import { ProgressView } from "./progress-view.js";
import { donePhrase } from "./labels.js";
import { fmtDuration, relTime, fmtTokens } from "./format.js";
import { Markdown } from "./markdown.js";
import type { TurnMeta, RunningAgent } from "./controller.js";
import type { StyledLine } from "./lines.js";
import { flattenSplash, flattenMessage, flattenMarkdown, flattenTool } from "./lines.js";
import { ModelPicker, PICKER_HEIGHT } from "./model-picker.js";
import { filterModelsForRole, adjustRoleModels } from "./role-models.js";
import { parseKittyKey } from "./keys.js";
import { COMMANDS, matchCommands, helpText, type SlashCommand } from "./commands.js";
import { readClipboardImage } from "./clipboard.js";
import { GLYPHS as ICONS } from "./glyphs.js";
import { helpSections } from "./help.js";
import { wordLeft, wordRight, lineStart, lineEnd } from "./input-edit.js";
import { atToken, listProjectFiles, rankFiles } from "./file-search.js";
import { shouldCollapsePaste, pasteToken, expandPasteTokens } from "./paste.js";

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

/** Width of the pending-question box (shared by the renderer + the fullscreen height math → same wrap → same line count). */
export function pendingWidth(cols: number): number {
  return Math.max(20, cols - 2);
}
/** Body wrap width: the box width minus the 2-space hanging indent under the header. */
export function pendingBodyWidth(cols: number): number {
  return Math.max(16, pendingWidth(cols) - 2);
}

/**
 * Renders a pending question/permission/review prompt: a colored icon + label header, then the body
 * rendered as markdown (bold/lists/code) — the body often contains a markdown-formatted numbered list.
 */
export function PendingQuestion({ text, cols }: { text: string; cols: number }): React.ReactElement {
  const { kind, body } = parsePending(text);
  const s = PENDING_STYLE[kind];
  const width = pendingWidth(cols);
  const lines = flattenMarkdown(body, pendingBodyWidth(cols));
  return (
    <Box flexDirection="column" width={width}>
      <Text color={s.color} bold>{`${s.icon} ${s.label}`}</Text>
      <Box flexDirection="column" paddingLeft={2}>
        {lines.map((line, i) => (
          <Text key={i}>
            {line.length === 0 ? " " : line.map((seg, j) => (
              <Text key={j} color={seg.color} backgroundColor={seg.backgroundColor} bold={seg.bold} italic={seg.italic} dimColor={seg.dim}>{seg.text}</Text>
            ))}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

/** Total rows a ChoiceInput occupies: border(2) + one row per option + hint(1). */
export function choiceHeight(optionCount: number): number {
  return optionCount + 3;
}

/**
 * Selectable answer list for a multiple-choice ask_user question (replaces the free-text input): arrow
 * keys move, space toggles a checkbox (multiSelect) or picks (single), Enter submits. The answer is the
 * selected option text(s) joined by "; ".
 */
export function ChoiceInput({ options, multiSelect, cols, onSubmit, onEscape }: {
  options: string[];
  multiSelect: boolean;
  cols: number;
  onSubmit: (answer: string) => void;
  onEscape?: () => void; // Esc → dismiss the selector (App falls back to a free-text answer)
}): React.ReactElement {
  const [cursor, setCursor] = useState(0);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  // Source-of-truth refs updated synchronously per keystroke (React 19 defers re-renders under load, so
  // reading render-derived state in the handler would go stale). setState only drives the visual.
  const cursorRef = useRef(0);
  const checkedRef = useRef<Set<number>>(new Set());
  const cfg = useRef({ options, multiSelect, onSubmit, onEscape });
  cfg.current = { options, multiSelect, onSubmit, onEscape };

  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  useEffect(() => {
    if (!stdin) return;
    if (isRawModeSupported && setRawMode) setRawMode(true);
    const onData = (chunk: Buffer | string): void => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const { options: opts, multiSelect: multi, onSubmit: submitCb, onEscape: escCb } = cfg.current;
      const kkEsc = parseKittyKey(s);
      // Esc (and Ctrl+C — treated as Esc inside a panel) → dismiss to free-text, never exit the app.
      if (s === "\x1b" || s === "\x03" || s === "\x1b[99;5u" || kkEsc?.type === "escape") { escCb?.(); return; }
      const submit = (): void => {
        const picks = multi
          ? (checkedRef.current.size ? [...checkedRef.current].sort((a, b) => a - b).map((i) => opts[i]) : [opts[cursorRef.current]])
          : [opts[cursorRef.current]];
        submitCb(picks.filter(Boolean).join("; "));
      };
      if (s === "\x1b[A" || s === "\x1bOA") { cursorRef.current = Math.max(0, cursorRef.current - 1); setCursor(cursorRef.current); return; }
      if (s === "\x1b[B" || s === "\x1bOB") { cursorRef.current = Math.min(opts.length - 1, cursorRef.current + 1); setCursor(cursorRef.current); return; }
      if (s === " ") {
        if (multi) {
          const nx = new Set(checkedRef.current);
          if (nx.has(cursorRef.current)) nx.delete(cursorRef.current); else nx.add(cursorRef.current);
          checkedRef.current = nx; setChecked(nx);
        } else submit();
        return;
      }
      const kk = parseKittyKey(s);
      if (s === "\r" || kk?.type === "enter") { submit(); return; }
    };
    stdin.on("data", onData);
    return () => { stdin.off("data", onData); };
  }, [stdin, setRawMode, isRawModeSupported]);

  const w = Math.max(24, cols - 2);
  return (
    <Box flexDirection="column" width={w} borderStyle="round" borderColor="cyan" paddingX={1}>
      {options.map((opt, i) => {
        const isSel = i === cursor;
        const mark = multiSelect ? (checked.has(i) ? "[x] " : "[ ] ") : (isSel ? "◉ " : "○ ");
        return (
          <Text key={i} wrap="truncate-end">
            <Text color={isSel ? "cyan" : undefined} inverse={isSel}>{`${isSel ? "› " : "  "}${mark}${opt}`}</Text>
          </Text>
        );
      })}
      <Text dimColor wrap="truncate-end">{(multiSelect ? "↑/↓ move · space toggle · Enter submit" : "↑/↓ move · space/Enter select") + " · Esc to type"}</Text>
    </Box>
  );
}

/** Full-width help overlay (opened with "?" on an empty input): grouped keybindings + slash commands. */
export function HelpOverlay({ cols }: { cols: number }): React.ReactElement {
  const w = Math.max(30, cols - 2);
  const sections = helpSections();
  const keyW = Math.min(20, Math.max(...sections.flatMap((s) => s.entries.map((e) => e.keys.length))) + 1);
  return (
    <Box flexDirection="column" width={w} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>Keyboard &amp; commands</Text>
      {sections.map((sec) => (
        <Box key={sec.title} flexDirection="column" marginTop={1}>
          <Text color="#ff9a2e">{sec.title}</Text>
          {sec.entries.map((e) => (
            <Text key={e.keys} wrap="truncate-end">
              <Text color="cyan">{`  ${e.keys.padEnd(keyW)}`}</Text>
              <Text dimColor>{e.desc}</Text>
            </Text>
          ))}
        </Box>
      ))}
      <Text dimColor>{"\n  Esc / q / ? to close"}</Text>
    </Box>
  );
}

/** @-file fuzzy picker shown above the input when the draft has an active "@query" token. */
export function FilePicker({ matches, selected, query, cols }: { matches: string[]; selected: number; query: string; cols: number }): React.ReactElement {
  const w = Math.max(24, cols - 2);
  return (
    <Box flexDirection="column" width={w} borderStyle="round" borderColor="cyan" paddingX={1}>
      {matches.length === 0 ? (
        <Text dimColor wrap="truncate-end">{`@${query} — no matching files`}</Text>
      ) : (
        matches.map((path, i) => {
          const isSel = i === selected;
          return (
            <Text key={path} wrap="truncate-end">
              <Text color={isSel ? "cyan" : undefined} inverse={isSel}>{`${isSel ? "› " : "  "}${path}`}</Text>
            </Text>
          );
        })
      )}
      <Text dimColor wrap="truncate-end">↑/↓ select · →/Tab/Enter insert · Esc cancel</Text>
    </Box>
  );
}

export type SendMode = "queue" | "byTheWay" | "steer";
const SEND_MODES: { mode: SendMode; key: string; label: string; desc: string }[] = [
  { mode: "queue", key: "q", label: "Queue", desc: "run after the current turn finishes" },
  { mode: "byTheWay", key: "b", label: "By the way", desc: "fold into the running turn (no restart)" },
  { mode: "steer", key: "s", label: "Steer", desc: "stop the current turn and run this next" },
];

/** Modal shown when you submit a prompt while a job runs: choose how the message is delivered. */
export function SendModePicker({ text, cols, onSelect, onEscape }: {
  text: string;
  cols: number;
  onSelect: (mode: SendMode) => void;
  onEscape: () => void;
}): React.ReactElement {
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(0);
  const cfg = useRef({ onSelect, onEscape });
  cfg.current = { onSelect, onEscape };
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  useEffect(() => {
    if (!stdin) return;
    if (isRawModeSupported && setRawMode) setRawMode(true);
    const onData = (chunk: Buffer | string): void => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const kk = parseKittyKey(s);
      if (s === "\x1b" || s === "\x03" || s === "\x1b[99;5u" || kk?.type === "escape") { cfg.current.onEscape(); return; }
      if (s === "\x1b[A" || s === "\x1bOA") { cursorRef.current = Math.max(0, cursorRef.current - 1); setCursor(cursorRef.current); return; }
      if (s === "\x1b[B" || s === "\x1bOB") { cursorRef.current = Math.min(SEND_MODES.length - 1, cursorRef.current + 1); setCursor(cursorRef.current); return; }
      const quick = SEND_MODES.find((m) => m.key === s.toLowerCase());
      if (quick) { cfg.current.onSelect(quick.mode); return; }
      if (s === "\r" || kk?.type === "enter") { cfg.current.onSelect(SEND_MODES[cursorRef.current].mode); return; }
    };
    stdin.on("data", onData);
    return () => { stdin.off("data", onData); };
  }, [stdin, setRawMode, isRawModeSupported]);

  const w = Math.max(24, cols - 2);
  const preview = text.length > w - 12 ? `${text.slice(0, w - 13)}…` : text;
  return (
    <Box flexDirection="column" width={w} borderStyle="round" borderColor="#ff9a2e" paddingX={1}>
      <Text dimColor wrap="truncate-end">{`Send while running: "${preview}"`}</Text>
      {SEND_MODES.map((m, i) => {
        const isSel = i === cursor;
        return (
          <Text key={m.mode} wrap="truncate-end">
            <Text color={isSel ? "#ff9a2e" : undefined} inverse={isSel} bold={isSel}>{`${isSel ? "› " : "  "}[${m.key}] ${m.label}`}</Text>
            <Text dimColor>{` — ${m.desc}`}</Text>
          </Text>
        );
      })}
      <Text dimColor wrap="truncate-end">↑/↓ or q/b/s · Enter select · Esc back to typing</Text>
    </Box>
  );
}

export const SLASH_PALETTE_ROWS = 8; // max command rows shown at once (windows around the selection)

/** Rows a slash palette occupies: border(2) + up to SLASH_PALETTE_ROWS command rows + hint(1). */
export function paletteHeight(count: number): number {
  return Math.min(count, SLASH_PALETTE_ROWS) + 3;
}

/** Slash-command palette shown above the input when the draft starts with "/". Windows around the selection. */
export function SlashPalette({ commands, selected, cols }: { commands: SlashCommand[]; selected: number; cols: number }): React.ReactElement {
  const w = Math.max(24, cols - 2);
  // Scroll a window of SLASH_PALETTE_ROWS commands so the selection stays visible (long command lists).
  const start = Math.max(0, Math.min(selected - Math.floor(SLASH_PALETTE_ROWS / 2), Math.max(0, commands.length - SLASH_PALETTE_ROWS)));
  const win = commands.slice(start, start + SLASH_PALETTE_ROWS);
  const windowed = commands.length > SLASH_PALETTE_ROWS;
  return (
    <Box flexDirection="column" width={w} borderStyle="round" borderColor="cyan" paddingX={1}>
      {win.map((c, k) => {
        const i = start + k;
        const isSel = i === selected;
        return (
          <Text key={c.name} wrap="truncate-end">
            <Text color={isSel ? "cyan" : undefined} inverse={isSel} bold={isSel}>{`${isSel ? "› " : "  "}${c.name}`}</Text>
            <Text dimColor>{`  ${c.desc}`}</Text>
          </Text>
        );
      })}
      <Text dimColor wrap="truncate-end">{`↑/↓ select · Enter run · → complete · Esc cancel${windowed ? ` · ${selected + 1}/${commands.length}` : ""}`}</Text>
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
        const dur = fmtDuration((a.doneAt ?? Date.now()) - a.startedAt); // freeze once the agent has reported
        const statusColor = a.status ? (/REJECT|revise/i.test(a.status) ? "#ff6b6b" : /APPROVE|pass/i.test(a.status) ? "green" : undefined) : undefined;
        // Per-agent metering, formatted like the main shimmer: model (duration · ↑prompt ↓completion).
        const tokens = a.promptTokens !== undefined ? ` · ↑${fmtTokens(a.promptTokens)} ↓${fmtTokens(a.completionTokens ?? 0)}` : "";
        return (
          <Text key={a.id} wrap="truncate-end">
            <Text color={a.status ? undefined : "cyan"}>{`  ${a.status ? "✔" : ICONS.msgBullet} `}</Text>
            {a.title}
            <Text dimColor>{`  · ${a.model ? `${a.model} ` : ""}(${dur}${tokens})`}</Text>
            {a.status ? <Text color={statusColor}>{`  · ${a.status}`}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}

/**
 * Live file-activity strip (WrongStack-style) shown under the input while a job runs: one row per recent
 * write/edit — "● write specs/001-x/spec.md · 45L". Hard-truncated to width so it never bleeds scrollback.
 */
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


export function InputLine({ value, cursor, onChange, onSubmit, width, paletteOpen = false, jobRunning = false, onPasteImage, onHelp, makePasteToken }: {
  value: string;
  cursor: number;
  onChange: (value: string, cursor: number) => void;
  onSubmit: (value: string) => void;
  width?: number;
  paletteOpen?: boolean; // when the slash palette is open, → is a "complete" gesture owned by App, not a cursor move
  jobRunning?: boolean;  // while a job runs, Ctrl+C is handled by App (cancel the job), not here (clear/exit)
  onPasteImage?: () => void; // Alt+V → grab an image off the clipboard (App reads it + stages it)
  onHelp?: () => void; // "?" on an empty input → open the help overlay
  makePasteToken?: (text: string) => string; // App collapses a large paste → returns the placeholder to insert
}): React.ReactElement {
  // Controlled: state lives in App (draft+cursor) → height is computed synchronously (no flicker on newline).
  const valRef = useRef(value); valRef.current = value;
  const curRef = useRef(cursor); curRef.current = cursor;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const onSubmitRef = useRef(onSubmit); onSubmitRef.current = onSubmit;
  const paletteRef = useRef(paletteOpen); paletteRef.current = paletteOpen;
  const runningRef = useRef(jobRunning); runningRef.current = jobRunning;
  // Empty-input Ctrl+C is a TWO-STEP quit: the first press arms + shows a hint, the second quits. Any other
  // keystroke disarms it. (A fast double-tap also force-quits via App's onCtrlC — this is the deliberate path.)
  const [exitArmed, setExitArmed] = useState(false);
  const exitArmedRef = useRef(false); exitArmedRef.current = exitArmed;
  useEffect(() => { if (jobRunning) setExitArmed(false); }, [jobRunning]); // a job started → drop the exit hint
  const onPasteImageRef = useRef(onPasteImage); onPasteImageRef.current = onPasteImage;
  const onHelpRef = useRef(onHelp); onHelpRef.current = onHelp;
  const makePasteTokenRef = useRef(makePasteToken); makePasteTokenRef.current = makePasteToken;
  const pasteRef = useRef<{ active: boolean; buf: string }>({ active: false, buf: "" }); // accumulates a bracketed paste across chunks
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  // Raw stdin: Enter(CR) submits; LF/kitty-CSI-u newline; left/right arrow moves the cursor; insert/delete
  // in the middle; Ctrl+C clears if non-empty, exits if empty. Up/down/PgUp go to App's useInput (scroll).
  useEffect(() => {
    if (!stdin) return;
    if (isRawModeSupported && setRawMode) setRawMode(true);
    // Insert a finished bracketed paste at the cursor (collapsed to a placeholder if large/multi-line).
    const finalizePaste = (text: string): void => {
      const v = valRef.current, c = curRef.current, change = onChangeRef.current;
      const insert = shouldCollapsePaste(text) && makePasteTokenRef.current ? makePasteTokenRef.current(text) : text;
      change(v.slice(0, c) + insert + v.slice(c), c + insert.length);
    };
    const onData = (chunk: Buffer | string): void => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      // Bracketed paste (\x1b[200~ … \x1b[201~): buffer the whole paste (may span chunks) and insert it as
      // one literal block — newlines preserved, no accidental submit on an embedded CR.
      if (pasteRef.current.active) {
        const end = s.indexOf("\x1b[201~");
        if (end === -1) { pasteRef.current.buf += s; return; }
        const full = pasteRef.current.buf + s.slice(0, end);
        pasteRef.current = { active: false, buf: "" };
        finalizePaste(full);
        return;
      }
      const start = s.indexOf("\x1b[200~");
      if (start !== -1) {
        const rest = s.slice(start + 6);
        const end = rest.indexOf("\x1b[201~");
        if (end === -1) { pasteRef.current = { active: true, buf: rest }; return; } // paste continues in the next chunk
        finalizePaste(rest.slice(0, end));
        return;
      }
      const v = valRef.current, c = curRef.current, change = onChangeRef.current;
      // Any key other than Ctrl+C cancels a pending "press Ctrl+C again to exit".
      if (s !== "\x03" && s !== "\x1b[99;5u" && exitArmedRef.current) setExitArmed(false);
      // Ctrl+C: while a job runs, defer to App (cancel the job). Non-empty input → clear it. Empty input → a
      // TWO-STEP quit: first press arms + hints, a second press quits (never quit on a single empty press).
      if (s === "\x03" || s === "\x1b[99;5u") {
        if (runningRef.current) return;
        if (v.length > 0) { change("", 0); setExitArmed(false); return; }
        if (exitArmedRef.current) { process.exit(0); }
        setExitArmed(true);
        return;
      }
      if (s === "\r") { onSubmitRef.current(v); return; }
      if (NEWLINE_SEQS.has(s)) { change(v.slice(0, c) + "\n" + v.slice(c), c + 1); return; }
      if (s === "\x7f" || s === "\x08") { if (c > 0) change(v.slice(0, c - 1) + v.slice(c), c - 1); return; }
      if (s === "\x1b[3~") { change(v.slice(0, c) + v.slice(c + 1), c); return; } // delete
      if (LEFT.has(s)) { change(v, Math.max(0, c - 1)); return; }
      if (RIGHT.has(s)) { if (paletteRef.current) return; change(v, Math.min(v.length, c + 1)); return; }
      if (HOME.has(s)) { change(v, 0); return; }
      if (END.has(s)) { change(v, v.length); return; }
      // Readline editing (emacs bindings): line motion, word motion, kill-word / kill-line.
      if (s === "\x01") { change(v, lineStart(v, c)); return; }                              // Ctrl+A → line start
      if (s === "\x05") { change(v, lineEnd(v, c)); return; }                                // Ctrl+E → line end
      if (s === "\x17") { const t = wordLeft(v, c); change(v.slice(0, t) + v.slice(c), t); return; } // Ctrl+W → delete word back
      if (s === "\x15") { const ls = lineStart(v, c); change(v.slice(0, ls) + v.slice(c), ls); return; } // Ctrl+U → kill to line start
      if (s === "\x0b") { const le = lineEnd(v, c); change(v.slice(0, c) + v.slice(le), c); return; }    // Ctrl+K → kill to line end
      if (s === "\x1b[1;5D" || s === "\x1bb") { change(v, wordLeft(v, c)); return; }          // Ctrl+← / Alt+B → word left
      if (s === "\x1b[1;5C" || s === "\x1bf") { change(v, wordRight(v, c)); return; }         // Ctrl+→ / Alt+F → word right
      if (s === "\x1bv" || s === "\x1bV") { onPasteImageRef.current?.(); return; } // Alt+V → paste clipboard image
      if (s === "?" && v.length === 0) { onHelpRef.current?.(); return; } // "?" on an empty input → help overlay
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
      {exitArmed ? <Text dimColor>  press Ctrl+C again to exit</Text> : null}
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
      <Text color="gray">{`${ICONS.userBullet} `}</Text>
      <Box width={w}><Text color="gray">{text}</Text></Box>
    </Box>
  ) : (
    <Box marginTop={1}>
      <Text color="green">{`${ICONS.msgBullet} `}</Text>
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

export function App({ controller, fullscreen = false, model, coachModel, refinerModel, listModels, setModel, setRoleModel, listRoles, adjustRoles, listSessions, resumeSession, listPins, addPin, removePin, listMemories, addMemory, removeMemory, listMcp, sourcesInfo, refreshSources, permMode, setPermMode, cancelJob, onExit }: {
  controller: TuiController;
  fullscreen?: boolean;
  model?: string;
  coachModel?: () => string; // the coach's model — always shown in the metrics line under the input (live getter)
  refinerModel?: () => string; // the refiner's model — shown only in the "refining… (model)" status line (live getter)
  listModels?: () => Promise<string[]>;
  setModel?: (m: string) => void;
  setRoleModel?: (role: string, models: string[]) => void; // per-role fallback chain (/roles setmodel, adjust)
  listRoles?: () => { name: string; model: string; models: string[]; council?: boolean; decider?: boolean }[]; // /roles → role → chain table
  adjustRoles?: () => Promise<void>; // /roles adjust → LLM-tuned assignment (streams rationale + applies chains)
  listSessions?: () => Promise<{ id: string; title: string; updatedAt: number; count: number }[]>; // /sessions (excludes the current one)
  resumeSession?: (id: string) => Promise<{ messages: { role: "user" | "assistant"; text: string }[] } | undefined>; // /resume
  listPins?: () => string[]; // /pins
  addPin?: (text: string) => Promise<{ ok: true; pin: string } | { ok: false; error: string }>; // /pin <text>
  removePin?: (n: number) => Promise<string | undefined>; // /pin rm N
  listMemories?: () => { text: string; kind?: "fact" | "lesson" | "rule" }[]; // /memories
  addMemory?: (text: string) => Promise<{ ok: true; entry: { text: string }; superseded: string[] } | { ok: false; error: string }>; // /remember
  removeMemory?: (n: number) => Promise<string | undefined>; // /forget N
  listMcp?: () => { name: string; ok: boolean; toolCount: number; error?: string }[]; // /mcp
  sourcesInfo?: () => { sources: string[]; manual: boolean; needsDiscovery: boolean }; // /sources
  refreshSources?: () => Promise<string[]>; // /sources refresh → re-probe connected sources
  permMode?: () => "ask" | "acceptEdits" | "auto"; // /mode: current permission mode
  setPermMode?: (m: "ask" | "acceptEdits" | "auto") => void; // /mode: change it live
  cancelJob?: () => void; // abort the running job (Steer send-mode)
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
  // Esc on a choice question dismisses the selector → fall back to free-text; reset per new question.
  const [choiceDismissed, setChoiceDismissed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false); // "?" overlay (keyboard + commands cheat-sheet)
  const [sendModeText, setSendModeText] = useState<string | null>(null); // prompt submitted mid-run, awaiting a send-mode choice
  const [atSel, setAtSel] = useState(0); // @-file picker selection
  const [atDismissed, setAtDismissed] = useState(false); // Esc dismisses the @-picker until the token changes
  const filesRef = useRef<string[] | null>(null); // project file list, loaded once when the @-picker first opens
  const [, setFilesTick] = useState(0); // bump to re-render after the file list loads
  // Collapsed pastes: the composer shows a ⟨paste #N⟩ placeholder; the full text is stored here and
  // re-expanded when the prompt is submitted.
  const pasteMapRef = useRef<Map<number, string>>(new Map());
  const pasteIdRef = useRef(0);
  const makePasteToken = (text: string): string => {
    const id = ++pasteIdRef.current;
    pasteMapRef.current.set(id, text);
    return pasteToken(id, text);
  };
  const slashCmds = matchCommands(draft);
  const slashOpen = (state.mode ?? "running") === "input" && !state.pending && draft.startsWith("/") && slashCmds.length > 0;
  const slashIdx = Math.min(slashSel, Math.max(0, slashCmds.length - 1));
  const completeSlash = (): void => { const c = slashCmds[slashIdx]; if (c) { setDraft(c.name); setDraftCursor(c.name.length); } };
  // @-file picker: active when the draft has an "@query" token at the cursor (and no other overlay owns input).
  const at = (state.mode ?? "running") === "input" && !state.pending && !slashOpen && !helpOpen && !atDismissed
    ? atToken(draft, draftCursor) : null;
  const atMatches = at && filesRef.current ? rankFiles(filesRef.current, at.query, 8) : [];
  const atOpen = !!at && filesRef.current !== null; // shown once the project file list has loaded
  const atIdx = Math.min(atSel, Math.max(0, atMatches.length - 1));
  const insertAtFile = (path: string): void => {
    if (!at) return;
    const before = draft.slice(0, at.start);
    const ins = `${path} `;
    setDraft(before + ins + draft.slice(draftCursor));
    setDraftCursor((before + ins).length);
    setAtSel(0);
  };
  // Send-mode picker (submit while a job runs): deliver the message as Queue / By-the-way / Steer.
  const dispatchSend = (mode: "queue" | "byTheWay" | "steer"): void => {
    const t = sendModeText;
    setSendModeText(null);
    if (t === null) return;
    if (mode === "byTheWay") { controller.addInboxNote(t); return; }
    controller.submitTask(t); // Queue and Steer both enqueue…
    if (mode === "steer") cancelJob?.(); // …Steer also aborts the current turn so the queued prompt runs now
  };
  const cancelSend = (): void => {
    const t = sendModeText;
    setSendModeText(null);
    if (t) { setDraft(t); setDraftCursor(t.length); } // Esc → back to editing the message
  };
  // Render a role's chain inline (side by side): `role` → primary ↳ fb1 ↳ fb2.
  const chainRows = (name: string, chain: string[]): string => {
    if (!chain.length) return `- \`${name}\` → —`;
    return `- \`${name}\` → ${chain[0]}${chain.slice(1).map((m) => `  ↳ ${m}`).join("")}`;
  };
  const rolesReport = (): string => {
    const all = listRoles?.() ?? [];
    const line = (r: { name: string; model: string; models: string[] }) => chainRows(r.name, r.models?.length ? r.models : r.model ? [r.model] : []);
    const main = all.filter((r) => !r.council).map(line);
    const team = all.filter((r) => r.council && !r.decider).map(line);
    const council = all.filter((r) => r.decider).map(line);
    const sections = [`**Roles & fallback chains:**\n${main.join("\n")}`];
    if (team.length) sections.push(`**Review team** (produces findings on the spec/plan):\n${team.join("\n")}`);
    if (council.length) sections.push(`**Review council** (votes on contested docs — strong models):\n${council.join("\n")}`);
    return `${sections.join("\n\n")}\n\n_\`/roles adjust\` auto-assigns 3-model chains · \`/roles setmodel\` builds one manually._`;
  };
  // /roles adjust → prefer the LLM-tuned assignment (reasons in chat); fall back to the local heuristic.
  const doRolesAdjust = (): void => {
    if (adjustRoles) { void adjustRoles(); return; } // LLM-driven: streams rationale + applies chains
    if (!listModels || !setRoleModel || !listRoles) { controller.note("Role adjust is not available."); return; }
    controller.note("Adjusting role models…");
    listModels().then((models) => {
      const adj = adjustRoleModels(listRoles().map((r) => r.name), models);
      if (adj.length === 0) { controller.note("No models available to assign."); return; }
      for (const { role, models: chain } of adj) setRoleModel(role, chain);
      const rows = adj.map(({ role, models: chain }) => chainRows(role, chain));
      controller.note(`**Roles adjusted** (primary + 2 fallbacks · sources spread · falls back on exhaustion):\n${rows.join("\n")}\n\n_\`/roles setmodel\` to fine-tune any chain._`);
    }, (e) => controller.note(`Adjust error: ${e instanceof Error ? e.message : String(e)}`));
  };
  // /sessions → list resumable sessions (newest first) as a numbered note.
  const doSessions = (): void => {
    if (!listSessions) { controller.note("Sessions are not available."); return; }
    listSessions().then((ss) => {
      if (ss.length === 0) { controller.note("No past sessions for this project yet."); return; }
      const rows = ss.map((s, i) => `${i + 1}. **${s.title}** — ${s.count} msg · ${relTime(s.updatedAt)}`);
      controller.note(`**Sessions** (this project):\n${rows.join("\n")}\n\n_Type \`/resume N\` to continue one._`);
    }, (e) => controller.note(`sessions error: ${e instanceof Error ? e.message : String(e)}`));
  };
  // /resume [N] → load the N-th (1-based, newest first) session; no arg = most recent.
  const doResume = (arg?: string): void => {
    if (!listSessions || !resumeSession) { controller.note("Resume is not available."); return; }
    const n = arg && /^\d+$/.test(arg.trim()) ? parseInt(arg.trim(), 10) : 1;
    listSessions().then((ss) => {
      const s = ss[n - 1];
      if (!s) { controller.note(`No session #${n} — type \`/sessions\` to list them.`); return; }
      resumeSession(s.id).then((d) => {
        if (!d) { controller.note("Could not load that session."); return; }
        controller.loadTranscript(d.messages);
        controller.note(`Resumed **${s.title}** (${d.messages.length} messages). Continue where you left off.`);
      });
    }, (e) => controller.note(`resume error: ${e instanceof Error ? e.message : String(e)}`));
  };
  // Alt+V → pull an image off the clipboard and stage it for the next prompt (coach sees it via vision).
  const pasteImage = (): void => {
    readClipboardImage().then(
      (uri) => {
        if (uri) controller.addAttachment(uri);
        else controller.note("No image on the clipboard — copy a screenshot first, then press Alt+V.");
      },
      () => controller.note("Could not read the clipboard."),
    );
  };
  // /next [N] → run the N-th coach-suggested follow-up (no arg = list them).
  const doNext = (arg?: string): void => {
    const steps = state.nextSteps;
    if (steps.length === 0) { controller.note("No next-step suggestions right now."); return; }
    if (!arg) {
      controller.note(`**Next steps:**\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n_Type \`/next N\` to run one._`);
      return;
    }
    const n = /^\d+$/.test(arg.trim()) ? parseInt(arg.trim(), 10) : 0;
    const step = steps[n - 1];
    if (!step) { controller.note(`No suggestion #${n} — type \`/next\` to list them.`); return; }
    historyRef.current = [...historyRef.current, step];
    controller.submitTask(step);
  };
  // /pins → list pinned facts.
  const doPins = (): void => {
    const pins = listPins?.() ?? [];
    if (pins.length === 0) { controller.note("No pins yet — `/pin <text>` to add one."); return; }
    controller.note(`**Pins** (this project):\n${pins.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n\n_\`/pin rm N\` to remove._`);
  };
  // /pin <text> (add) · /pin rm N (remove) · /pin (list).
  const doPin = (arg: string): void => {
    if (!addPin || !removePin) { controller.note("Pins are not available."); return; }
    const rm = arg.match(/^rm\s+(\d+)$/i);
    if (rm) { removePin(parseInt(rm[1], 10)).then((r) => controller.note(r ? `Unpinned: ${r}` : `No pin #${rm[1]}.`)); return; }
    if (!arg.trim()) { doPins(); return; }
    addPin(arg.trim()).then((r) => controller.note(r.ok ? `Pinned: ${r.pin}` : `Couldn't pin: ${r.error}`));
  };
  // /memories → list remembered facts.
  const doMemories = (): void => {
    const mem = listMemories?.() ?? [];
    if (mem.length === 0) { controller.note("No memories yet — `/remember <text>` to add one."); return; }
    const mark = (k?: string) => (k === "lesson" ? "📖 " : k === "rule" ? "📌 " : "🧠 ");
    const rows = mem.map((m, i) => `${i + 1}. ${mark(m.kind)}${m.text}`);
    controller.note(`**Memories** (this project):\n${rows.join("\n")}\n\n_📌 = rule · 📖 = lesson · 🧠 = fact · \`/forget N\` to remove._`);
  };
  // /remember <text> → store a cross-session fact.
  const doRemember = (text: string): void => {
    if (!addMemory) { controller.note("Memory is not available."); return; }
    if (!text.trim()) { controller.note("Usage: `/remember <text>`"); return; }
    addMemory(text.trim()).then((r) => controller.note(
      r.ok ? `Remembered: ${r.entry.text}${r.superseded.length ? ` (replaced: ${r.superseded.join("; ")})` : ""}` : `Couldn't remember: ${r.error}`,
    ));
  };
  // /forget N → remove a remembered fact.
  const doForget = (arg: string): void => {
    if (!removeMemory) { controller.note("Memory is not available."); return; }
    const n = /^\d+$/.test(arg.trim()) ? parseInt(arg.trim(), 10) : 0;
    if (!n) { doMemories(); return; }
    removeMemory(n).then((r) => controller.note(r ? `Forgot: ${r}` : `No memory #${n}.`));
  };
  // /mcp → show connected MCP servers + tool counts.
  const doMcp = (): void => {
    const servers = listMcp?.() ?? [];
    if (servers.length === 0) { controller.note("No MCP servers configured (add an `mcp` block to config.json)."); return; }
    const rows = servers.map((s) => s.ok ? `- ✅ **${s.name}** — ${s.toolCount} tools` : `- ❌ **${s.name}** — ${s.error ?? "not connected"}`);
    controller.note(`**MCP servers:**\n${rows.join("\n")}`);
  };
  // /sources [refresh] → show the connected model sources; refresh re-probes omniroute.
  const doSources = (arg: string): void => {
    const info = sourcesInfo?.();
    if (arg.trim().toLowerCase() === "refresh") {
      if (!refreshSources) { controller.note("Source discovery is not available."); return; }
      controller.note("Re-detecting your connected model sources (probing omniroute)…");
      refreshSources().then(
        (found) => controller.note(found.length ? `Model sources: ${found.join(", ")} (cached).` : "No connected sources found — showing all."),
        (e) => controller.note(`Discovery failed: ${e instanceof Error ? e.message : String(e)}`),
      );
      return;
    }
    if (!info) { controller.note("Source info is not available."); return; }
    const how = info.manual ? "from config `modelSources`" : info.sources.length ? "auto-detected (cached)" : "not detected yet — all sources shown";
    const list = info.sources.length ? info.sources.map((s) => `- ${s}`).join("\n") : "- (all)";
    controller.note(`**Model sources** (${how}):\n${list}\n\n_\`/sources refresh\` to re-probe your connected subscriptions._`);
  };
  // /mode [ask|acceptEdits|auto] → show or set the permission mode.
  const MODE_DESC: Record<string, string> = {
    ask: "prompt for every file write and command",
    acceptEdits: "auto-approve file writes/edits, prompt for commands",
    auto: "auto-approve everything except dangerous commands",
  };
  const doMode = (arg: string): void => {
    const cur = permMode?.() ?? "ask";
    const a = arg.trim().toLowerCase();
    // No arg → open a keyboard-navigable picker (↑/↓ + Enter). The note lists what each mode does.
    if (!a) {
      const note = `Current: ${cur}. ` + (["ask", "acceptEdits", "auto"] as const).map((m) => `${m} = ${MODE_DESC[m]}`).join(" · ");
      controller.openModePicker(["ask", "acceptEdits", "auto"], note);
      return;
    }
    const m = a === "ask" ? "ask" : a === "acceptedits" ? "acceptEdits" : a === "auto" ? "auto" : undefined;
    if (!m) { controller.note(`Unknown mode \`${arg.trim()}\` — use ask, acceptEdits, or auto.`); return; }
    setPermMode?.(m);
    controller.note(`Permission mode → **${m}** — ${MODE_DESC[m]}.`);
  };
  const runSlash = (c: SlashCommand): void => {
    setScroll(0); setDraft(""); setDraftCursor(0); setSlashSel(0);
    if (c.name === "/model") controller.openPicker();
    else if (c.name === "/roles") controller.note(rolesReport());
    else if (c.name === "/sessions") doSessions();
    else if (c.name === "/resume") doResume();
    else if (c.name === "/next") doNext();
    else if (c.name === "/pins") doPins();
    else if (c.name === "/pin") doPin("");
    else if (c.name === "/memories") doMemories();
    else if (c.name === "/remember") doRemember("");
    else if (c.name === "/forget") doForget("");
    else if (c.name === "/mcp") doMcp();
    else if (c.name === "/sources") doSources("");
    else if (c.name === "/mode") doMode("");
    else if (c.name === "/help") controller.note(helpText());
    else if (c.name === "/clear") controller.clearTranscript();
    else if (c.name === "/exit") onExit?.();
  };
  const tlen = state.transcript.length;
  useEffect(() => { setScroll(0); }, [tlen]);
  useEffect(() => { setChoiceDismissed(false); }, [state.pending?.question]); // new question → show the selector again
  // @-file picker: load the project file list once when the picker first opens; reset selection/dismissal.
  const atActive = !!at;
  useEffect(() => {
    if (atActive && filesRef.current === null) {
      listProjectFiles(process.cwd()).then(
        (f) => { filesRef.current = f; setFilesTick((x) => x + 1); },
        () => { filesRef.current = []; setFilesTick((x) => x + 1); },
      );
    }
    if (!atActive) setAtDismissed(false); // token gone → re-arm the picker for the next "@"
  }, [atActive]);
  useEffect(() => { setAtSel(0); }, [at?.query]);
  // When the picker opens (loading), fetch the model list and hand it to the controller. Re-runs for each
  // chain slot (picked grows) so already-chosen models are filtered out of the next slot's options.
  const pickedCount = state.picker?.picked?.length ?? 0;
  useEffect(() => {
    if (state.mode === "picker" && state.picker?.loading && listModels) {
      let cancelled = false;
      const role = state.picker.role; // set only for /roles setmodel → filter models to fit the role
      const picked = state.picker.picked ?? []; // chain models already chosen → excluded from this slot
      listModels().then(
        (models) => {
          if (cancelled) return;
          const { models: shown, note } = role ? filterModelsForRole(role, models, picked) : { models, note: undefined };
          controller.setPickerModels(shown, note);
        },
        (e) => { if (!cancelled) controller.setPickerError(e instanceof Error ? e.message : String(e)); },
      );
      return () => { cancelled = true; };
    }
    return undefined;
  }, [state.mode, state.picker?.loading, pickedCount, listModels, controller]);
  // Scroll / command-history keys via RAW stdin instead of Ink's useInput. Ink's parseKeypress can
  // yield an undefined `sequence` for some keys (e.g. numpad in application-keypad mode), then
  // `input.startsWith('')` throws and crashes the app. Parsing the few sequences we care about
  // ourselves and ignoring the rest sidesteps that entirely.
  const { stdin: rootStdin } = useStdin();
  const keyRef = useRef<(s: string) => void>(() => {});
  keyRef.current = (s: string): void => {
    // Help overlay owns stdin while open: Esc / q / ? closes it, everything else is swallowed.
    if (helpOpen) { if (s === "\x1b" || s === "q" || s === "?") setHelpOpen(false); return; }
    if (sendModeText !== null) return; // the SendModePicker owns stdin while it's open
    if (!fullscreen || state.mode === "picker") return;
    if (state.pending?.options?.length) return; // ChoiceInput owns stdin while a choice is pending
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
    // @-file picker owns ↑/↓ (select), →/Tab (insert), Esc (dismiss) while it's open.
    if (atOpen) {
      if (up) { setAtSel((n) => Math.max(0, n - 1)); return; }
      if (down) { setAtSel((n) => Math.min(atMatches.length - 1, n + 1)); return; }
      if (RIGHT.has(s) || s === "\t") { const p = atMatches[atIdx]; if (p) insertAtFile(p); return; }
      const kk = parseKittyKey(s);
      if (s === "\x1b" || kk?.type === "escape") { setAtDismissed(true); return; }
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
        <ProgressView phase={state.phase} detail={state.detail} refinerModel={refinerModel?.()} meta={state.meta} cols={size.cols} />
        {state.pending ? <Prompt question={state.pending.question} onSubmit={(s) => controller.answer(s)} /> : null}
      </Box>
    );

  // Fullscreen (Claude Code model): flatten content into plain styled lines → manually render the
  // exactly-fitting window (no Ink overflow bug). The input is ALWAYS visible at the bottom; while a job
  // runs, a cyan status box sits above it and a metrics line below it. ↑/↓/PgUp/PgDn scrolls history.
  if (fullscreen) {
    // Chat content sits one unit off the left edge (paddingLeft below); flatten to the narrowed width so lines
    // still fit within the indented column and don't wrap early.
    const CHAT_INDENT = 2;
    const chatW = size.cols - CHAT_INDENT;
    const allLines: StyledLine[] = [
      ...flattenSplash(chatW, size.rows),
      ...state.transcript.flatMap((m) => ("kind" in m ? flattenTool(m.activity, chatW) : flattenMessage(m.role, m.text, chatW))),
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
          <Box paddingLeft={CHAT_INDENT}><ViewportLines lines={win} height={viewportH} /></Box>
          <Text dimColor> </Text>
          <Box marginTop={1}>
            {(() => {
              const pk = state.picker;
              const isRole = pk?.stage === "role";
              const isMode = pk?.stage === "mode";
              const roleModel = pk?.role ? (listRoles?.().find((r) => r.name === pk.role)?.model ?? "—") : undefined;
              const slot = (pk?.picked?.length ?? 0) + 1; // 1-based chain slot being picked
              const slots = pk?.slots ?? 1;
              const slotLabel = slots > 1 ? (slot === 1 ? "primary" : `fallback ${slot - 1}`) : "";
              const chainTitle = pk?.role
                ? `${pk.role} — ${slotLabel} model (${slot}/${slots})${pk.picked?.length ? ` · so far: ${pk.picked.join(" → ")}` : ""}`
                : "Select model";
              const title = isMode ? "Select permission mode" : isRole ? "Select role" : chainTitle;
              const current = isMode ? (permMode?.() ?? "") : isRole ? "" : (roleModel ?? (state.currentModel || model || "—"));
              return (
                <ModelPicker
                  key={`${pk?.stage}:${pk?.role ?? "global"}:${slot}`} // remount per stage/slot → cursor/filter reset
                  models={pk?.models ?? []}
                  current={current}
                  loading={pk?.loading ?? false}
                  error={pk?.error}
                  cols={size.cols}
                  title={title}
                  note={pk?.note}
                  onSelect={(item) => {
                    if (isMode) {                                                              // /mode: apply the picked mode
                      const m = item as "ask" | "acceptEdits" | "auto";
                      setPermMode?.(m); controller.applyMode(m, MODE_DESC[m] ?? "");
                      return;
                    }
                    if (isRole) { controller.chooseRole(item, 3); return; }                   // step 1 → chain slot 1 (3 models)
                    if (pk?.role) {                                                            // per-role: build the chain
                      const chain = [...(pk.picked ?? []), item];
                      if (controller.addChainModel(item)) { setRoleModel?.(pk.role, chain); controller.applyRoleModel(pk.role, chain); }
                      return;
                    }
                    setModel?.(item); controller.applyModel(item);                            // session-wide (/model)
                  }}
                  onCancel={() => controller.cancelPicker()}
                />
              );
            })()}
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
    // NB: no kanban board here — task progress is surfaced as chat ACTION notes (📋 X → In progress) instead.
    // Pending prompt: 1 header line + the markdown-flattened body lines (same width as PendingQuestion → same count).
    const pendingLines = state.pending
      ? 1 + flattenMarkdown(parsePending(state.pending.question).body, pendingBodyWidth(size.cols)).length
      : 0;
    const liveH = progressLine && state.liveActivity ? 1 : 0; // the transient "writing…" line
    const statusH = (progressLine || doneLine ? 1 : 0) + liveH + pendingLines; // progress/done(1) + live + pending
    const inputMarginTop = showStatus ? 0 : 1; // no blank line between the status label and the input
    // A pending choice question replaces the free-text input with a ChoiceInput selector.
    const choiceOptions = state.pending?.options ?? [];
    const choiceActive = choiceOptions.length > 0 && !choiceDismissed; // Esc dismisses → free-text fallback
    // Help overlay height: border(2) + title(1) + per-section (marginTop 1 + title 1 + entries) + footer(2).
    const helpH = 2 + 1 + helpSections().reduce((a, s) => a + 2 + s.entries.length, 0) + 2;
    const inputBoxH = sendModeText !== null
      ? inputMarginTop + 6 // send-mode picker: border(2) + title(1) + 3 modes + hint(1) - 1
      : helpOpen
        ? inputMarginTop + helpH
        : choiceActive
          ? inputMarginTop + choiceHeight(choiceOptions.length)
          : 2 + inputMarginTop + inputH; // border(2) + marginTop + inputH
    const metricsH = state.meta ? 1 : 0;
    const metricsGapH = state.meta ? 1 : 0; // small blank line below the info line
    const queuedH = state.queued > 0 ? 1 : 0;
    // Live-agents panel under the input: 1 header line + one row per running sub-agent.
    const agentsH = state.runningAgents.length > 0 ? 1 + state.runningAgents.length : 0;
    const paletteH = slashOpen ? paletteHeight(slashCmds.length) : 0; // border(2) + windowed command rows + hint(1)
    const atH = atOpen ? Math.max(1, atMatches.length) + 3 : 0; // border(2) + file rows (min 1 for "no match") + hint(1)
    const nextH = state.nextSteps.length > 0 ? state.nextSteps.length + 1 : 0; // header(1) + one line per suggestion
    const bottomH = statusH + paletteH + atH + inputBoxH + metricsH + queuedH + metricsGapH + agentsH + nextH;
    const viewportH = Math.max(3, size.rows - bottomH - 1); // -1: scroll hint line
    const maxScroll = Math.max(0, allLines.length - viewportH);
    maxScrollRef.current = maxScroll;
    const clamped = Math.min(scroll, maxScroll);
    const end = allLines.length - clamped;
    const windowed = allLines.slice(Math.max(0, end - viewportH), end);
    return (
      <Box flexDirection="column" height={size.rows}>
        <Box paddingLeft={CHAT_INDENT}><ViewportLines lines={windowed} height={viewportH} /></Box>
        <Text dimColor>{clamped > 0 ? `  ↓ ${clamped} more · ↓/PgDn to jump to bottom` : " "}</Text>
        {showStatus ? (
          <Box flexDirection="column">
            {progressLine ? <Box paddingLeft={2}><ProgressView phase={state.phase} detail={state.detail} refinerModel={refinerModel?.()} meta={state.meta} cols={size.cols} /></Box> : null}
            {progressLine && state.liveActivity ? <Box paddingLeft={2}><Text color="#1a9fd8" wrap="truncate-end">{`  ✎ ${state.liveActivity}`}</Text></Box> : null}
            {doneLine ? <Box paddingLeft={2}><Text dimColor>{`${donePhrase(state.phase)} for ${fmtDuration(state.meta?.durationMs ?? 0)}${state.meta ? ` · ↑${fmtTokens(state.meta.promptTokens)} ↓${fmtTokens(state.meta.completionTokens)} · ${state.meta.calls} call${state.meta.calls === 1 ? "" : "s"}` : ""}`}</Text></Box> : null}
            {state.pending ? <PendingQuestion text={state.pending.question} cols={size.cols} /> : null}
          </Box>
        ) : null}
        {slashOpen ? <SlashPalette commands={slashCmds} selected={slashIdx} cols={size.cols} /> : null}
        {atOpen ? <FilePicker matches={atMatches} selected={atIdx} query={at?.query ?? ""} cols={size.cols} /> : null}
        {sendModeText !== null ? (
          <Box marginTop={inputMarginTop}>
            <SendModePicker text={sendModeText} cols={size.cols} onSelect={dispatchSend} onEscape={cancelSend} />
          </Box>
        ) : helpOpen ? (
          <Box marginTop={inputMarginTop}><HelpOverlay cols={size.cols} /></Box>
        ) : choiceActive ? (
          <Box marginTop={inputMarginTop}>
            <ChoiceInput
              options={choiceOptions}
              multiSelect={!!state.pending?.multiSelect}
              cols={size.cols}
              onSubmit={(ans) => { setScroll(0); controller.answer(ans); }}
              onEscape={() => setChoiceDismissed(true)}
            />
          </Box>
        ) : (
        <Box marginTop={inputMarginTop} borderStyle="round" borderColor={state.pending ? "yellow" : "gray"} paddingX={1} width={size.cols} flexShrink={0}>
          <InputLine
            value={draft}
            cursor={draftCursor}
            width={cw}
            paletteOpen={slashOpen || atOpen}
            jobRunning={running}
            onPasteImage={pasteImage}
            onHelp={() => setHelpOpen(true)}
            makePasteToken={makePasteToken}
            onChange={(v, c) => { if (v !== draftRef.current) histIdxRef.current = -1; setDraft(v); setDraftCursor(c); setSlashSel(0); }}
            onSubmit={(t) => {
              // Pending approval question → the answer routes to controller.answer (single input, no modal).
              if (state.pending) { setScroll(0); setDraft(""); setDraftCursor(0); controller.answer(t); return; }
              // @-file picker open → Enter inserts the highlighted path instead of submitting.
              if (atOpen) { const p = atMatches[atIdx]; if (p) { insertAtFile(p); return; } }
              // Slash palette open → Enter runs the highlighted command instead of submitting a prompt.
              if (slashOpen) { const c = slashCmds[slashIdx]; if (c) { runSlash(c); return; } }
              const trimmed = t.trim();
              const cmd = trimmed.toLowerCase();
              // A fully-typed known command (palette closed) → run it.
              const known = COMMANDS.find((c) => c.name === cmd);
              if (known) { runSlash(known); return; }
              if (cmd === "/roles setmodel") { setScroll(0); setDraft(""); setDraftCursor(0); controller.openRolePicker((listRoles?.() ?? []).map((r) => r.name)); return; }
              if (cmd === "/roles adjust") { setScroll(0); setDraft(""); setDraftCursor(0); doRolesAdjust(); return; }
              // /resume N (argument form) → resume the N-th session.
              if (cmd.startsWith("/resume ")) { setScroll(0); setDraft(""); setDraftCursor(0); doResume(trimmed.slice("/resume".length).trim()); return; }
              // /next N (argument form) → run the N-th suggested follow-up.
              if (cmd.startsWith("/next ")) { setScroll(0); setDraft(""); setDraftCursor(0); doNext(trimmed.slice("/next".length).trim()); return; }
              // /pin <text> | /pin rm N (argument form).
              if (cmd.startsWith("/pin ")) { setScroll(0); setDraft(""); setDraftCursor(0); doPin(trimmed.slice("/pin".length).trim()); return; }
              // /remember <text> · /forget N (argument forms).
              if (cmd.startsWith("/remember ")) { setScroll(0); setDraft(""); setDraftCursor(0); doRemember(trimmed.slice("/remember".length).trim()); return; }
              if (cmd.startsWith("/forget ")) { setScroll(0); setDraft(""); setDraftCursor(0); doForget(trimmed.slice("/forget".length).trim()); return; }
              // /sources refresh (argument form).
              if (cmd.startsWith("/sources ")) { setScroll(0); setDraft(""); setDraftCursor(0); doSources(trimmed.slice("/sources".length).trim()); return; }
              // /mode <value> (argument form) — case-sensitive value (acceptEdits), so slice off the raw text.
              if (cmd.startsWith("/mode ")) { setScroll(0); setDraft(""); setDraftCursor(0); doMode(trimmed.slice("/mode".length).trim()); return; }
              // Any other slash input is an unknown command → warn, NEVER send it to the LLM.
              if (trimmed.startsWith("/")) {
                setScroll(0); setDraft(""); setDraftCursor(0);
                controller.note(`Unknown command: \`${trimmed}\` — type \`/\` to see the available commands.`);
                return;
              }
              // Expand any collapsed-paste placeholders back to their full text before the prompt goes out.
              const full = expandPasteTokens(t, pasteMapRef.current);
              pasteMapRef.current.clear(); pasteIdRef.current = 0;
              if (full.trim()) historyRef.current = [...historyRef.current, full];
              histIdxRef.current = -1; stashRef.current = "";
              setScroll(0); setDraft(""); setDraftCursor(0);
              // Submitting a plain prompt WHILE a job runs → ask how to deliver it (Queue / By-the-way / Steer).
              if (running && full.trim()) { setSendModeText(full); return; }
              controller.submitTask(full);
            }}
          />
        </Box>
        )}
        {state.attachments > 0 ? <Text color="#ff9a2e">{`  ${ICONS.attach} ${state.attachments} image${state.attachments === 1 ? "" : "s"} staged — Enter to send`}</Text> : null}
        {state.nextSteps.length > 0 ? (
          <Box flexDirection="column">
            <Text color="#ff9a2e" wrap="truncate-end">{"  Suggested next steps — /next N:"}</Text>
            {state.nextSteps.map((s, i) => <Text key={i} dimColor wrap="truncate-end">{`    ${i + 1}. ${s}`}</Text>)}
          </Box>
        ) : null}
        {state.meta ? <MetricsLine meta={state.meta} model={state.currentModel || coachModel?.() || model} /> : null}
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
    ...state.transcript.flatMap((m) => ("kind" in m ? [] : [{ kind: "msg" as const, role: m.role, text: m.text, cols: size.cols }])),
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
