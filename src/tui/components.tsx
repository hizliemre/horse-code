import React, { useEffect, useState, useRef, useMemo, memo } from "react";
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
import { applyKey } from "./input-edit.js";
import { atToken, listProjectFiles, rankFiles } from "./file-search.js";
import { shouldCollapsePaste, pasteToken, expandPasteTokens } from "./paste.js";
import type { AskChoice } from "../engine/review.js";
import { asChoice } from "../engine/review.js";
import { readTelemetry, summarize, describeReport, type RunReport as MonitorReport } from "../obs/report.js";
import { writeHeapSnapshot, estimateFreezeSeconds } from "../obs/telemetry.js";
import { TelemetryTail } from "../obs/tail.js";
import { WatchManager, type WatchStatus } from "../obs/watch.js";

const COLUMNS: Column[] = ["TODO", "IN-PROGRESS", "REVIEW", "DONE", "MERGED", "PARKED", "ABANDONED"];

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
  // -4: the two-column indent of the block itself, plus the terminal's own margin.
  return Math.max(20, cols - 4);
}
/**
 * Body wrap width — the width the body is actually DRAWN in.
 *
 * It used to subtract one indent when there are two: the block's own `paddingLeft` and the body's hanging
 * indent under the header. Wrapping to two columns more than the box then made Ink re-wrap every line that
 * fell between the two widths, and each re-wrap is a row nobody counted. The block renders taller than the
 * layout reserved, the frame overflows the terminal, and the terminal scrolls the TOP away — which is why a
 * question kept losing its first bullet, the first character of its bold header ("25 standing rule(s)"
 * arriving as "5 standing rule(s)"), and finally its option labels.
 */
export function pendingBodyWidth(cols: number): number {
  return Math.max(16, pendingWidth(cols) - 4);
}

/**
 * What the run is spending itself on, drawn under the agents in the same shape.
 *
 * The agent panel says WHO is working; this says what it is costing — the slot time by stage, how many tool
 * calls a turn asks for, and whether one agent is reading one file over and over. Those three questions came
 * from watching real runs from the outside with a script; a tool that cannot answer them about itself makes
 * everyone rediscover them by hand.
 */
export function RunMonitor({ report, watches = [], cols }: {
  report: MonitorReport; watches?: WatchStatus[]; cols: number;
}): React.ReactElement {
  const width = Math.max(20, cols - 2);
  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text dimColor>{`Running monitors${watches.length ? ` · ${watches.filter((w) => w.alive).length} watch(es)` : ""}`}</Text>
      {monitorLines(report, watches).map((l, i) => (
        <Text key={i} wrap="truncate-end" dimColor={i > 0}>{l.length ? l : " "}</Text>
      ))}
    </Box>
  );
}

/**
 * The panel's rows, shared with the height math — the two disagreeing is how Ink ends up painting the
 * bottom region over the transcript, which has happened twice.
 */
export function monitorLines(r: MonitorReport, watches: WatchStatus[] = []): string[] {
  const out: string[] = [];
  if (!r.records && !watches.length) return ["waiting for the first records…"];
  const secs = (n: number): string => (n < 90 ? `${Math.round(n)}s` : `${Math.round(n / 60)}m`);
  // Nothing recorded at all is not the same as "no stage has finished": with only watches running, the run's
  // own numbers have not started yet and saying anything about them would be an invention.
  if (r.records) {
  if (r.stages.length) {
    const total = r.stages.reduce((n, s) => n + s.seconds, 0) || 1;
    for (const s of r.stages.slice(0, 5)) {
      out.push(`  ${s.stage.padEnd(16)} ${secs(s.seconds).padStart(5)}  ${String(Math.round((s.seconds / total) * 100)).padStart(3)}%  ` +
        `${s.runs}x${s.failed ? ` · ${s.failed} failed` : ""}`);
    }
  } else {
    out.push("  no stage has finished yet");
  }
  if (r.turns) {
    const single = Math.round((r.singleToolTurns / r.turns) * 100);
    out.push(`  ${"model".padEnd(16)} ${secs(r.modelSeconds).padStart(5)}  ${r.turns} turns · ` +
      `${(r.toolCalls / r.turns).toFixed(2)} tools/turn (${single}% single) · ${(r.promptTokens / 1e6).toFixed(1)}M tok`);
  }
  if (r.errors.length) {
    out.push(`  ${"failed calls".padEnd(16)} ${r.errors.map((e) => `${e.model} x${e.count}`).join(", ")}`);
  }
  // A pipeline can go completely quiet while one request hangs; this is the only thing that says so.
  if (r.inFlight.count) {
    const age = r.inFlight.oldestMs >= 90_000 ? `${Math.round(r.inFlight.oldestMs / 60_000)}m` : `${Math.round(r.inFlight.oldestMs / 1000)}s`;
    out.push(`  ${"in flight".padEnd(16)} ${r.inFlight.count} call(s), oldest ${age}  ${r.inFlight.models.join(", ").slice(0, 46)}`);
  }
  // Three heap deaths so far. A number on screen turns the fourth into something seen coming.
  if (r.heap) {
    out.push(`  ${"memory".padEnd(16)} heap ${r.heap.usedMb}MB (peak ${r.heap.peakMb}) · rss ${r.heap.rssMb}MB`);
  }
  // A whole attempt spent on a model that answered in prose and called no tool at all.
  if (r.wroteNothing.length) {
    out.push(`  ${"wrote nothing".padEnd(16)} ${r.wroteNothing.map((e) => `${e.model} x${e.count}`).join(", ")}`);
  }
  }
  // The signature of a context-elision loop: one agent, one file, over and over.
  const worst = r.reReads[0];
  if (worst) {
    const name = worst.subject.slice(worst.subject.lastIndexOf("/") + 1);
    out.push(`  ${"re-read most".padEnd(16)} ${worst.task} ${name} x${worst.count}`);
  }
  // The user's own watches, under the run's own numbers: both are monitors, and the last line each one
  // printed is the whole reason it was started.
  for (const w of watches.slice(-4)) {
    const state = w.alive ? `${w.events} event(s)` : (w.exit ?? "ended");
    out.push(`  ${(w.alive ? "● " : "○ ") + w.name}`.padEnd(18) + ` ${state}` +
      (w.last ? `  ${w.last.slice(0, 60)}` : ""));
  }
  return out;
}

/**
 * Renders a pending question/permission/review prompt: a colored icon + label header, then the body
 * rendered as markdown (bold/lists/code) — the body often contains a markdown-formatted numbered list.
 */
/**
 * Keeps a question readable when it cannot fit: head and tail, with the middle named rather than dropped.
 *
 * A question is asked WITH its options, and the options are the part the user has to act on. When the two
 * together overflow the terminal, something has to give, and it must not be the answer list — a real 20-row
 * terminal was measured rendering a twelve-rule import question with BOTH option labels missing and the
 * question's own first characters gone ("2 standing rule(s)" for twelve). The user pressed Enter on a choice
 * they could not see and got "No".
 *
 * The first lines carry what is being asked and the last carries the actual question ("Import them?"), so the
 * middle — the enumeration — is what yields, and it says how much it took.
 */
export function elideLines<T>(lines: T[], max: number, marker: (n: number) => T): T[] {
  if (max <= 0 || lines.length <= max) return lines;
  if (max === 1) return [marker(lines.length - 1)];
  const tail = Math.min(1, max - 2);           // keep the closing question when there is room for it
  const head = max - 1 - tail;                 // …the rest is the opening, minus the marker's own row
  return [...lines.slice(0, head), marker(lines.length - head - tail), ...lines.slice(lines.length - tail)];
}

export function PendingQuestion({ text, cols, maxLines }: { text: string; cols: number; maxLines?: number }): React.ReactElement {
  const { kind, body } = parsePending(text);
  const s = PENDING_STYLE[kind];
  const width = pendingWidth(cols);
  const all = flattenMarkdown(body, pendingBodyWidth(cols));
  const lines = maxLines === undefined ? all
    : elideLines(all, maxLines, (n) => [{ text: `… ${n} more line(s) — scroll up after answering`, dim: true }]);
  return (
    // Indented as a whole: the header sat flush at the left margin while the transcript around it is
    // indented, so the question read as a separate thing bolted on rather than part of the conversation.
    // The body keeps its offset from the header, so the two still nest.
    <Box flexDirection="column" width={width} paddingLeft={2}>
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

/**
 * Wraps plain text to a width, breaking on spaces.
 *
 * Shared by the render and the height calculation, which is the point: an option that wraps to three lines
 * has to be reserved three rows, and the only way those two stay in step is for them to be the same code.
 */
/**
 * Rows the note area always occupies.
 *
 * It used to be a single `truncate-end` line, so a note longer than the terminal was cut with an ellipsis and
 * the caret went with it — the user could not see what they were typing, which is the one thing a text field
 * has to do. Wrapping alone would make the box grow as you type, and the box's height is reserved in advance
 * by `choiceHeight`; a render taller than its reservation is what pushes other rows off the screen.
 *
 * So the area is FIXED and shows the TAIL: the newest lines, where the caret is.
 */
export const NOTE_ROWS = 3;

/**
 * The selection markers, in plain ASCII.
 *
 * They were `◉`, `○` and `›` — all three East Asian AMBIGUOUS width. A terminal configured to draw ambiguous
 * glyphs two columns wide (a common pairing with certain fonts and locales) disagrees with the one column
 * `string-width` counts, and the row that carries them is laid out to the wrong width. Reported repeatedly
 * from a real terminal: the marker line of every option came out blank, so the user could not see which
 * option was selected and pressed Enter on a choice they could not read.
 *
 * The multi-select markers were `[x]`/`[ ]` all along and never broke — that is the evidence. These match
 * them, so a radio group and a checkbox group now read as the same widget in the same alphabet.
 *
 * Deliberately NOT switchable by icon style: a marker you cannot see is not decoration, it is the control.
 */
export const RADIO_ON = "(*)";
export const RADIO_OFF = "( )";
export const CURSOR = ">";

/**
 * The note area's lines: the LAST {@link NOTE_ROWS} of the wrapped note, padded to that height.
 *
 * `null` means "nothing typed yet" — the caller renders the hint for it. The caret rides the final line so it
 * is on screen no matter how long the note grows.
 */
export function noteLines(note: string, noting: boolean, width: number): (string | null)[] {
  const w = Math.max(8, width - "Notes: ".length);
  if (!noting && !note) return [null, ...Array<string>(NOTE_ROWS - 1).fill("")];
  const wrapped = wrapPlain(noting ? `${note}▌` : note, w);
  const tail = wrapped.slice(Math.max(0, wrapped.length - NOTE_ROWS));
  return [...tail, ...Array<string>(NOTE_ROWS - tail.length).fill("")];
}

export function wrapPlain(text: string, width: number): string[] {
  const w = Math.max(8, width);
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!line.length) line = word;
      else if (line.length + 1 + word.length <= w) line += ` ${word}`;
      else { out.push(line); line = word; }
      // A single word longer than the column is cut rather than pushing the box wider.
      while (line.length > w) { out.push(line.slice(0, w)); line = line.slice(w); }
    }
    out.push(line);
  }
  return out.length ? out : [""];
}

/**
 * Total rows a ChoiceInput occupies — counted from what it actually draws.
 *
 * This said `optionCount + 3`, from a version that drew one row per option and had no notes line. It then
 * grew a description row per option, a notes row, and a preview panel, and none of them were added here. The
 * component reserved less space than it painted, so Ink drew over the region above it: the question the user
 * was answering got overwritten, and option text collided mid-line with the option below.
 *
 * Kept beside the render deliberately. The two must agree, and the only way to notice they have stopped is
 * to have them where a change to one is visibly a change to the other.
 */
export function choiceHeight(options: (string | AskChoice)[], cols = 80): number {
  const choices = options.map((o) => (typeof o === "string" ? { label: o } : o));
  const w = Math.max(24, cols - 2);
  const hasAnyPreview = choices.some((c) => c.preview);
  const listW = hasAnyPreview && w >= 80 ? Math.floor(w * 0.4) : w;
  // Options WRAP rather than truncate, so a long one takes several rows — and an option the user cannot
  // read is not a choice they can make.
  const listRows = choices.reduce(
    (n, c) => n + wrapPlain(c.label, listW - 4).length + (c.description ? wrapPlain(c.description, listW - 6).length : 0),
    0,
  );

  // The preview belongs to the focused option, so the tallest one is what has to fit.
  const previewRows = choices.reduce((n, c) => Math.max(n, c.preview ? c.preview.split("\n").length : 0), 0);
  const hasPreview = previewRows > 0;
  const sideBySide = hasPreview && w >= 80;

  const body = sideBySide
    // Side by side: the row is as tall as whichever column is taller; the preview carries its own border.
    ? Math.max(listRows, previewRows + 2)
    // Stacked: the list, then a margin, then the bordered preview underneath it.
    : listRows + (hasPreview ? previewRows + 3 : 0);

  return 2 /* border */ + body + NOTE_ROWS /* notes — fixed, see NOTE_ROWS */ + 1 /* hint */;
}

/**
 * Selectable answer list for a multiple-choice ask_user question (replaces the free-text input): arrow
 * keys move, space toggles a checkbox (multiSelect) or picks (single), Enter submits. The answer is the
 * selected option text(s) joined by "; ".
 */
export function ChoiceInput({ options, multiSelect, cols, onSubmit, onEscape }: {
  options: (string | AskChoice)[];
  multiSelect: boolean;
  cols: number;
  onSubmit: (answer: string) => void;
  onEscape?: () => void; // Esc → dismiss the selector (App falls back to a free-text answer)
}): React.ReactElement {
  const choices = options.map(asChoice);
  const [cursor, setCursor] = useState(0);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  // A free-text note attached to the answer. Some choices need a qualifier the options cannot enumerate
  // ("B, but keep the old adapter") — without it the user has to Esc out and lose the structured choice.
  const [note, setNote] = useState("");
  const [noting, setNoting] = useState(false);
  // Source-of-truth refs updated synchronously per keystroke (React 19 defers re-renders under load, so
  // reading render-derived state in the handler would go stale). setState only drives the visual.
  const cursorRef = useRef(0);
  const checkedRef = useRef<Set<number>>(new Set());
  const noteRef = useRef("");
  const notingRef = useRef(false);
  const cfg = useRef({ choices, multiSelect, onSubmit, onEscape });
  cfg.current = { choices, multiSelect, onSubmit, onEscape };

  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  useEffect(() => {
    if (!stdin) return;
    if (isRawModeSupported && setRawMode) setRawMode(true);
    const onData = (chunk: Buffer | string): void => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const { choices: opts, multiSelect: multi, onSubmit: submitCb, onEscape: escCb } = cfg.current;
      const kk = parseKittyKey(s);
      const isEsc = s === "\x1b" || s === "\x03" || s === "\x1b[99;5u" || kk?.type === "escape";
      const isEnter = s === "\r" || kk?.type === "enter";

      // While typing a note the list keys are OFF: every character belongs to the note.
      if (notingRef.current) {
        if (isEsc) {
          // Discard, as the footer promises — leaving the text behind would silently attach a note the user
          // just cancelled.
          noteRef.current = ""; setNote("");
          notingRef.current = false; setNoting(false);
          return;
        }
        if (isEnter) { notingRef.current = false; setNoting(false); return; } // confirm → back to the list
        if (s === "\x7f" || s === "\b") { noteRef.current = noteRef.current.slice(0, -1); setNote(noteRef.current); return; }
        if (s >= " " && !s.startsWith("\x1b")) { noteRef.current += s; setNote(noteRef.current); }
        return;
      }

      if (isEsc) { escCb?.(); return; }
      const submit = (): void => {
        const picks = multi
          ? (checkedRef.current.size ? [...checkedRef.current].sort((a, b) => a - b).map((i) => opts[i]?.label) : [opts[cursorRef.current]?.label])
          : [opts[cursorRef.current]?.label];
        const answer = picks.filter(Boolean).join("; ");
        const n = noteRef.current.trim();
        submitCb(n ? `${answer}\n\nNote: ${n}` : answer);
      };
      if (s === "\x1b[A" || s === "\x1bOA") { cursorRef.current = Math.max(0, cursorRef.current - 1); setCursor(cursorRef.current); return; }
      if (s === "\x1b[B" || s === "\x1bOB") { cursorRef.current = Math.min(opts.length - 1, cursorRef.current + 1); setCursor(cursorRef.current); return; }
      if (s === "n" || s === "N") { notingRef.current = true; setNoting(true); return; }
      if (s === " ") {
        if (multi) {
          const nx = new Set(checkedRef.current);
          if (nx.has(cursorRef.current)) nx.delete(cursorRef.current); else nx.add(cursorRef.current);
          checkedRef.current = nx; setChecked(nx);
        } else submit();
        return;
      }
      if (isEnter) { submit(); return; }
    };
    stdin.on("data", onData);
    return () => { stdin.off("data", onData); };
  }, [stdin, setRawMode, isRawModeSupported]);

  const w = Math.max(24, cols - 2);
  const preview = choices[cursor]?.preview;
  // Side-by-side only when there is room; a narrow terminal stacks the preview under the list instead of
  // squeezing both into unreadable columns.
  const sideBySide = !!preview && w >= 80;
  const listW = sideBySide ? Math.floor(w * 0.4) : w;
  const previewW = w - listW - 3;
  const hint = (multiSelect ? "↑/↓ move · space toggle · Enter submit" : "↑/↓ move · space/Enter select")
    + " · n to add notes · Esc to type";

  const list = (
    <Box flexDirection="column" width={listW}>
      {choices.map((c, i) => {
        const isSel = i === cursor;
        const mark = multiSelect ? (checked.has(i) ? "[x] " : "[ ] ") : (isSel ? `${RADIO_ON} ` : `${RADIO_OFF} `);
        return (
          <Box key={i} flexDirection="column">
            {/*
              * One <Text> per line, like every other line in this box.
              *
              * The label used to be a <Text> nested inside a <Text>, and it is the ONLY nested one here —
              * the description, the note and the hint are all flat. It is also the only line that went
              * missing, repeatedly, in a real terminal while rendering correctly in-process: the frame Ink
              * composes contains it, so what fails is the update that carries it to the screen. Nesting is
              * the one structural difference between the line that vanishes and the lines that do not, and
              * it buys nothing here — the whole line shares one style.
              */}
            {wrapPlain(c.label, listW - 4).map((line, k) => (
              <Text key={k} color={isSel ? "cyan" : undefined} bold={isSel}>
                {k === 0 ? `${isSel ? `${CURSOR} ` : "  "}${mark}${line}` : `      ${line}`}
              </Text>
            ))}
            {c.description
              ? wrapPlain(c.description, listW - 6).map((line, k) => (
                <Text key={`d${k}`} dimColor>{`      ${line}`}</Text>
              ))
              : null}
          </Box>
        );
      })}
    </Box>
  );

  return (
    <Box flexDirection="column" width={w} borderStyle="round" borderColor="cyan" paddingX={1}>
      {sideBySide ? (
        <Box flexDirection="row">
          {list}
          <Box flexDirection="column" width={previewW} marginLeft={2} borderStyle="round" borderColor="gray" paddingX={1}>
            {(preview ?? "").split("\n").map((line, i) => <Text key={i} dimColor wrap="truncate-end">{line}</Text>)}
          </Box>
        </Box>
      ) : (
        <>
          {list}
          {preview ? (
            <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
              {preview.split("\n").map((line, i) => <Text key={i} dimColor wrap="truncate-end">{line}</Text>)}
            </Box>
          ) : null}
        </>
      )}
      {noteLines(note, noting, w - 2).map((line, i) => (
        <Text key={`n${i}`} wrap="truncate-end">
          {i === 0 ? <Text dimColor>{"Notes: "}</Text> : <Text>{"       "}</Text>}
          {line === null
            ? <Text dimColor italic>press n to add notes</Text>
            : <Text color={noting ? "cyan" : undefined}>{line}</Text>}
        </Text>
      ))}
      <Text dimColor wrap="truncate-end">{noting ? "Enter to confirm the note · Esc to discard it" : hint}</Text>
    </Box>
  );
}

/** Full-width help overlay (opened with "?" on an empty input): grouped keybindings + slash commands. */
/**
 * Whether a chunk of stdin should close the help overlay.
 *
 * Matched by CONTAINMENT, not equality. A chunk is not a keystroke: fast typing, a paste, and a terminal
 * that batches its writes all deliver several bytes at once, and an equality test then recognises none of
 * them — leaving the overlay open with nothing else able to close it, because it replaces the input line.
 * Ctrl+C counts too: it is what anyone reaches for when a screen will not go away.
 */
export function closesHelp(s: string): boolean {
  return /[q?]/i.test(s) || s.includes("\x1b") || s.includes("\x03");
}

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
  { mode: "byTheWay", key: "b", label: "By the way", desc: "answer it now — the running work is untouched" },
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
/**
 * How often the terminal is asked whether it is still in raw mode.
 *
 * Often enough that a stolen terminal is unusable for a moment rather than for the rest of the session;
 * rare enough to be free — it is one property read.
 */
export const RAW_MODE_CHECK_MS = 250;

/** When a running agent's clock stops being reassuring. Three quarters of the implementer's own budget. */
export const LONG_RUNNING_MS = 15 * 60 * 1000;

/** How often `/monitor watch` reports. Long enough that a change means something, short enough to notice. */
export const MONITOR_INTERVAL_MS = 5 * 60 * 1000;

/** History rows kept while panels are being dropped — below this the transcript is not worth calling one. */
export const MIN_VIEWPORT_ROWS = 3;

/**
 * Drops optional blocks, in the order given, until the whole frame fits the terminal.
 *
 * The bottom region grows with everything that is happening at once — eight agent rows, a detail box, the
 * monitor, a pinned answer, the next-step list — and nothing bounded the total. Past the terminal's height
 * the frame is simply TALLER than the screen: Ink writes it, the terminal scrolls to make room, and the
 * input box is carried off the top. From then on every keystroke lands at the bottom of a scrolled terminal
 * and is wiped by the next repaint, which is exactly what a user reported after scrolling.
 *
 * Dropped in a deliberate order — the run's own numbers before the agents' names, and everything before the
 * input. `keep` is checked by name at each render site.
 */
export function dropToFit(
  rows: number,
  fixedHeight: number,
  optional: { name: string; height: number }[],
): Set<string> {
  const keep = new Set(optional.map((o) => o.name));
  let total = fixedHeight + optional.reduce((n, o) => n + o.height, 0);
  for (const o of optional) {
    if (total + MIN_VIEWPORT_ROWS + 1 <= rows) break; // +1: the scroll-hint line
    if (o.height <= 0) continue;
    keep.delete(o.name);
    total -= o.height;
  }
  return keep;
}

export function RunningAgents({ agents, cols, cursor }: { agents: RunningAgent[]; cols: number; cursor?: number }): React.ReactElement {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);
  const selected = cursor !== undefined ? agents[cursor] : undefined;
  const width = Math.max(20, cols - 2);
  // The detail panel sits BESIDE the list when the terminal is wide enough for both to say anything, and
  // under it when it is not — a 30-column column of wrapped fragments helps nobody.
  const side = width >= 100;
  const listW = selected ? (side ? Math.floor(width * 0.55) : width) : width;
  return (
    <Box flexDirection={side ? "row" : "column"} width={width}>
      <Box flexDirection="column" width={listW} borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>{`Running agents (${agents.length})${cursor === undefined ? " · ↑/↓ to inspect" : ""}`}</Text>
        {agents.map((a, i) => {
          const dur = fmtDuration((a.doneAt ?? Date.now()) - a.startedAt); // freeze once the agent has reported
          const statusColor = a.status
            ? (/UNVERIFIED|no response/i.test(a.status) ? "#ffb454" // amber — a lens that couldn't review (blocking)
              : /REJECT|revise/i.test(a.status) ? "#ff6b6b"
              : /APPROVE|pass/i.test(a.status) ? "green" : undefined)
            : undefined;
          const on = i === cursor;
          // An implementer gets 20 minutes; past three quarters of that it is not working, it is stuck, and
          // the row should say so before the budget quietly ends the attempt.
          const slow = !a.status && (a.doneAt ?? Date.now()) - a.startedAt > LONG_RUNNING_MS;
          return (
            <Text key={a.id} wrap="truncate-end" inverse={on}>
              <Text color={a.status ? undefined : "cyan"}>{`${on ? "›" : " "}${a.status ? "✔" : ICONS.msgBullet} `}</Text>
              {a.role ? <Text color="#7dd3fc">{`${a.role} `}</Text> : null}
              {a.title}
              <Text dimColor={!slow} color={slow ? "#ffb454" : undefined}>{`  · ${a.model ? `${a.model} ` : ""}(${dur})`}</Text>
              {a.status ? <Text color={statusColor}>{`  · ${a.status}`}</Text> : null}
            </Text>
          );
        })}
      </Box>
      {selected ? (
        <Box flexDirection="column" width={side ? width - listW : width} borderStyle="round" borderColor="#7dd3fc" paddingX={1}>
          {agentDetail(selected).map((l, i) => (
            <Text key={i} wrap="truncate-end" dimColor={i > 0 && l.startsWith("  ")}>{l.length ? l : " "}</Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * What an agent is: its role, its model, the task, what it has spent, and the calls it has just made.
 *
 * Shared with the height math, which is why it returns lines rather than rendering them — the two disagreeing
 * is how Ink ends up painting the bottom region over the transcript.
 */
export function agentDetail(a: RunningAgent): string[] {
  const dur = fmtDuration((a.doneAt ?? Date.now()) - a.startedAt);
  const spend = a.promptTokens !== undefined ? ` · ↑${fmtTokens(a.promptTokens)} ↓${fmtTokens(a.completionTokens ?? 0)}` : "";
  const out = [
    a.title,
    `  role   ${a.role ?? "—"}`,
    `  model  ${a.model ?? "—"}`,
    `  time   ${dur}${spend}${a.callCount ? ` · ${a.callCount} call${a.callCount === 1 ? "" : "s"}` : ""}`,
  ];
  if (a.status) out.push(`  result ${a.status}`);
  const doing = agentActivity(a);
  if (doing) out.push("", `  ${doing}`);
  return out;
}

/**
 * One line saying what the agent is DOING, in place of a list of its tool calls.
 *
 * The list was a transcript of mechanics — `read_file(…transport.ts)` eight times over — and reading it told
 * you nothing you could act on. What a person wants from a row they highlighted is the sentence they would
 * have written themselves: it is running the tests, it is editing this file, it is searching for that.
 */
export function agentActivity(a: RunningAgent): string {
  const calls = a.calls ?? [];
  const last = calls[calls.length - 1];
  if (!last) return a.status ? "" : "starting up…";
  const name = (p: string): string => p.slice(p.lastIndexOf("/") + 1) || p;
  const recent = calls.slice(-4);
  switch (last.tool) {
    case "write_file":
    case "edit_file":
      return `writing ${name(last.target)}`;
    case "shell": {
      const cmd = last.target.replace(/^cd\s+\S+\s*&&\s*/, "").trim();
      if (/\b(test|vitest|jest|karma|ng test)\b/.test(cmd)) return "running the tests";
      if (/\b(build|tsc|ng build)\b/.test(cmd)) return "building";
      if (/^git\b/.test(cmd)) return "checking git";
      if (/\b(install|npm i|pnpm add|yarn add)\b/.test(cmd)) return "installing dependencies";
      return `running ${cmd.split(/\s+/)[0]}`;
    }
    case "grep":
    case "glob":
      return `searching for ${last.target.slice(0, 40)}`;
    case "read_file": {
      // Several reads in a row is orientation, not a single lookup — say that rather than naming the last file.
      const reads = recent.filter((c) => c.tool === "read_file").length;
      return reads >= 3 ? `reading through the code (${name(last.target)}…)` : `reading ${name(last.target)}`;
    }
    case "submit":
      return "writing up its answer";
    default:
      return `${last.tool} · ${name(last.target).slice(0, 40)}`;
  }
}

/**
 * Live file-activity strip (WrongStack-style) shown under the input while a job runs: one row per recent
 * write/edit — "● write specs/001-x/spec.md · 45L". Hard-truncated to width so it never bleeds scrollback.
 */
// Sequences counted as newline (do NOT submit): plain LF, Alt+Enter (ESC+CR/LF), and the known
// escapes terminals send for Shift+Enter (kitty CSI-u, xterm modifyOtherKeys).
const NEWLINE_SEQS = new Set(["\n", "\x1b\r", "\x1b\n", "\x1b[13;2u", "\x1b[27;2;13~"]);

const RIGHT = new Set(["\x1b[C", "\x1bOC"]);

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
      // The palette owns → while it is open (it moves the selection), so that guard comes before editing.
      if (RIGHT.has(s) && paletteRef.current) return;
      // Every motion and deletion key, from one table — see applyKey.
      const ed = applyKey(s, v, c);
      if (ed) { change(ed.value, ed.cursor); return; }
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

export function App({ controller, fullscreen = false, model, coachModel, refinerModel, listModels, setModel, setRoleModel, listRoles, adjustRoles, listSessions, resumeSession, listPins, addPin, removePin, listMemories, addMemory, removeMemory, listMcp, sourcesInfo, refreshSources, listSkills, updateSkills, addSkill, graphStatus, buildGraph, planTraces, runTraces, migrate, continueFromClaude, addMcp, answerByTheWay, telemetryPath, parallel, setParallel, permMode, setPermMode, cancelJob, onExit }: {
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
  listMemories?: () => { text: string; kind?: "fact" | "lesson" | "rule"; state?: string; audience?: string[] }[]; // /memories
  addMemory?: (text: string) => Promise<{ ok: true; entry: { text: string }; superseded: string[] } | { ok: false; error: string }>; // /remember
  removeMemory?: (n: number) => Promise<string | undefined>; // /forget N
  listMcp?: () => { name: string; ok: boolean; toolCount: number; error?: string }[]; // /mcp
  sourcesInfo?: () => { sources: string[]; manual: boolean; needsDiscovery: boolean }; // /sources
  refreshSources?: () => Promise<string[]>; // /sources refresh → re-probe connected sources
  listSkills?: () => { name: string; description: string; roles: string[] }[]; // /skills
  updateSkills?: () => Promise<string>; // /skills update → re-install externally-sourced skills
  addSkill?: (url: string) => Promise<string>; // /skills add <url> → install from a repo
  graphStatus?: () => Promise<string>; // /graph
  buildGraph?: () => Promise<string>; // /graph build
  migrate?: () => Promise<string>; // /migrate
  continueFromClaude?: (arg: string) => Promise<void>; // /continue-from-claude <worktree name>
  addMcp?: (input: string) => Promise<string>; // /mcp add <url|command>
  answerByTheWay?: (question: string) => void; // a question asked while work is running
  telemetryPath?: string; // this run's telemetry log → /monitor reads it
  parallel?: () => number; // how many tasks may run at once
  setParallel?: (n: number) => void; // /parallel N — live, and persisted
  planTraces?: () => Promise<{ summary: string; jobs: number }>; // /graph trace → the free estimate
  runTraces?: () => Promise<string>; // /graph trace, after consent
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
  /**
   * The palette opens whenever a slash is typed — including while a job runs.
   *
   * It used to require the idle state, so pressing `/` during a run showed nothing at all: the commands were
   * still there and still worked, they simply could not be seen or completed. Typing is allowed during a run
   * (that is what the send-mode picker is for), so the help for what can be typed has to be as well.
   */
  const slashOpen = !state.pending && draft.startsWith("/") && slashCmds.length > 0;
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
    // While a job runs, nothing will read the inbox until it ends — so the question is answered now
    // instead of being queued behind hours of work.
    if (mode === "byTheWay") { controller.addInboxNote(t, state.mode === "running" ? answerByTheWay : undefined); return; }
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
    // A memory that is no longer trustworthy must SAY so — silently withholding it would leave the user
    // believing the agent still knows something it has stopped using.
    const flag = (m: { state?: string; audience?: string[] }) => {
      const parts: string[] = [];
      if (m.state && m.state !== "active") parts.push(m.state === "stale" ? "⚠ stale (the file it describes changed)" : m.state === "contradicted" ? "⚠ contradicted by a newer note" : "⌛ expired");
      if (m.audience?.length) parts.push(`for: ${m.audience.join(", ")}`);
      return parts.length ? ` _(${parts.join(" · ")})_` : "";
    };
    const rows = mem.map((m, i) => `${i + 1}. ${mark(m.kind)}${m.text}${flag(m)}`);
    const inactive = mem.filter((m) => m.state && m.state !== "active").length;
    const note = inactive ? `\n\n_${inactive} memory(ies) are no longer injected — re-\`/remember\` to refresh, or \`/forget N\`._` : "";
    controller.note(`**Memories** (this project):\n${rows.join("\n")}\n\n_📌 = rule · 📖 = lesson · 🧠 = fact · \`/forget N\` to remove._${note}`);
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
  /**
   * `/monitor` — what the run is spending its time on, from its own telemetry.
   *
   * The same three questions that turned out to matter while watching real runs from the outside: where the
   * slot time goes, whether turns are asking for one tool at a time, and whether an agent is reading one file
   * over and over. `watch` repeats it, because the useful version of this was never a snapshot — it was
   * noticing that a number had moved.
   */
  /**
   * The monitor panel's own state: a tail that only reads what the log has appended, polled on a timer.
   *
   * OFF by default. The panel answers a question people ask occasionally — where is the time going — and
   * showing it always costs rows in the bottom region on every single run, which is the scarcest space in
   * the interface. `/monitor enable` turns it on for the session, `/monitor disable` turns it back off.
   */
  const tailRef = useRef<TelemetryTail | undefined>(undefined);
  if (telemetryPath && !tailRef.current) tailRef.current = new TelemetryTail(telemetryPath);
  const [monitorOn, setMonitorOn] = useState(false);
  const [monitorReport, setMonitorReport] = useState<MonitorReport | undefined>(undefined);
  useEffect(() => {
    const tail = tailRef.current;
    if (!tail || !monitorOn) return undefined;
    const poll = (): void => setMonitorReport(tail.read());
    poll();
    const timer = setInterval(poll, MONITOR_INTERVAL_MS);
    timer.unref?.(); // a repeating read must never be the reason the process stays alive
    return () => clearInterval(timer);
  }, [monitorOn]);

  /**
   * `/watch` — any command, its output lines as events.
   *
   * The run monitor answers fixed questions about horse-code; this answers whatever the user is actually
   * waiting on. The command is one THEY typed, so it runs without an approval prompt — the same as typing it
   * in a terminal — but it is killed as a process group when they stop it or the session ends, because a
   * watcher that outlives its stop is how this project ended up with a day-old orphan holding a terminal.
   */
  const watchesRef = useRef<WatchManager | undefined>(undefined);
  const [watches, setWatches] = useState<WatchStatus[]>([]);
  if (!watchesRef.current) {
    watchesRef.current = new WatchManager(
      (w, line) => {
        controller.note(`👁️ \`${w.name}\` ${line}`);
        setWatches(watchesRef.current?.list() ?? []);
      },
      (w) => {
        controller.note(`👁️ \`${w.name}\` ${w.exit ?? "ended"}` +
          (w.suppressed ? ` · ${w.suppressed} line(s) suppressed` : ""));
        setWatches(watchesRef.current?.list() ?? []);
      },
    );
  }
  useEffect(() => () => watchesRef.current?.stopAll(), []);

  const doWatch = (arg = ""): void => {
    const mgr = watchesRef.current;
    if (!mgr) return;
    const text = arg.trim();
    const stop = /^stop\s+(\d+)$/i.exec(text);
    if (stop) {
      const id = Number(stop[1]);
      controller.note(mgr.stop(id) ? `Watch ${id} stopped.` : `Watch ${id} is not running.`);
      setWatches(mgr.list());
      return;
    }
    if (text.toLowerCase() === "stop") { mgr.stopAll(); controller.note("All watches stopped."); setWatches(mgr.list()); return; }
    if (!text) {
      const live = mgr.list();
      controller.note(live.length
        ? live.map((w) => `${w.alive ? "●" : "○"} ${w.id}. \`${w.name}\` — ${w.command} · ${w.events} event(s)` +
            `${w.suppressed ? `, ${w.suppressed} suppressed` : ""}${w.exit ? ` · ${w.exit}` : ""}`).join("\n")
        : "No watches. `/watch <command>` starts one — every line it prints becomes an event.");
      return;
    }
    const w = mgr.start(text);
    controller.note(`👁️ Watching \`${w.name}\` — \`${text}\`. Each line it prints lands here; \`/watch stop ${w.id}\` ends it.`);
    setWatches(mgr.list());
  };

  const doMonitor = (arg = ""): void => {
    if (!telemetryPath) { controller.note("Telemetry is off for this session — nothing to monitor."); return; }
    const a = arg.trim().toLowerCase();
    if (a === "disable" || a === "off") {
      setMonitorOn(false);
      controller.note("Monitor panel off — `/monitor enable` turns it back on.");
      return;
    }
    if (a === "log") { controller.note(`📈 Telemetry log: \`${telemetryPath}\``); return; }
    if (a === "heap") {
      /**
       * Say the cost, paint it, THEN freeze.
       *
       * A heap cannot be walked while it changes, so this stops the world for as long as the walk takes — 70
       * seconds on a 2.7 GB heap. The first version called it "a moment", a user's terminal locked up, and
       * they had no way to tell a long pause from a hang. The delay before the blocking call is there so Ink
       * gets a frame out first: a warning nobody can see is not a warning.
       */
      const secs = estimateFreezeSeconds();
      controller.note(
        `🧠 Writing a heap snapshot. **Everything freezes for about ${secs}s** — the UI, the agents, all of it — ` +
        `because a heap cannot be walked while it changes. The file will be roughly the size of the heap.`);
      void new Promise((r) => setTimeout(r, 200))
        .then(() => writeHeapSnapshot(telemetryPath.slice(0, telemetryPath.lastIndexOf("/"))))
        .then((path) => {
        controller.note(path
          ? `🧠 Heap snapshot → \`${path}\`. Take a second one later and compare them in Chrome DevTools ` +
            `(Memory → Load profile → Comparison) to see what grew.`
          : "The heap snapshot could not be written.");
      });
      return;
    }
    if (a === "enable" || a === "on") {
      setMonitorOn(true);
      controller.note("Monitor panel on — `/monitor disable` turns it off.");
      return;
    }
    // Bare `/monitor` is a one-off reading, written to the chat so the numbers at THIS moment survive in the
    // transcript. It does not turn the panel on: showing it is a separate, deliberate choice.
    const tail = tailRef.current;
    if (tail) controller.note(`📈 ${describeReport(tail.read())}`);
  };

  /**
   * `/parallel` — how many tasks run at once.
   *
   * The right number is a property of the user's subscriptions, not of this tool: it is how many parallel
   * calls their model sources tolerate. It is live because the answer is usually learned from watching a
   * running job, which is exactly when restarting to change it is most expensive.
   */
  const doParallel = (arg = ""): void => {
    const n = Number(arg.trim());
    if (!arg.trim()) {
      controller.note(`Up to **${parallel?.() ?? "?"}** task(s) run at once. \`/parallel N\` changes it (1–32).`);
      return;
    }
    if (!Number.isInteger(n) || n < 1 || n > 32) {
      controller.note(`\`/parallel\` takes a whole number from 1 to 32 — "${arg.trim()}" is not one.`);
      return;
    }
    if (!setParallel) { controller.note("This session cannot change the parallelism."); return; }
    setParallel(n);
    controller.note(`Up to **${n}** task(s) will now run at once — the running job picks it up as tasks finish.`);
  };

  const doMcp = (arg = ""): void => {
    const add = /^add\s+(.+)$/is.exec(arg.trim());
    if (add) {
      if (!addMcp) { controller.note("MCP installation is not available."); return; }
      controller.note("Working out the server configuration, then starting it to check it actually works…");
      addMcp(add[1]).then((r) => controller.note(r), (e) => controller.note(`Install failed: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    if (arg.trim().toLowerCase() === "add") {
      controller.note("Usage: `/mcp add <url|command>` — e.g. `/mcp add https://angular.dev/ai/mcp` or `/mcp add npx -y @angular/cli mcp`");
      return;
    }
    const servers = listMcp?.() ?? [];
    if (servers.length === 0) { controller.note("No MCP servers configured (add an `mcp` block to config.json)."); return; }
    const rows = servers.map((s) => s.ok ? `- ✅ **${s.name}** — ${s.toolCount} tools` : `- ❌ **${s.name}** — ${s.error ?? "not connected"}`);
    controller.note(`**MCP servers:**\n${rows.join("\n")}\n\n_\`/mcp add <url|command>\` to install another._`);
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
  // /migrate → discover another tool's setup, then decide group by group what comes across.
  const doMigrate = (): void => {
    if (!migrate) { controller.note("Migration is not available."); return; }
    migrate().then((r) => controller.note(r), (e) => controller.note(`Migration failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  // /continue-from-claude <name> → take over a Claude Code worktree's branch as the base for what comes next.
  const doContinueFromClaude = (arg: string): void => {
    if (!continueFromClaude) { controller.note("Continuing from another tool's worktree is not available."); return; }
    void continueFromClaude(arg);
  };
  // /graph [build] → the project's code graph: what exists, whether it is fresh, and rebuilding it.
  const doGraph = (arg: string): void => {
    if (!graphStatus || !buildGraph) { controller.note("The project graph is not available."); return; }
    if (arg.trim().toLowerCase() === "build") {
      controller.note("Building the project code graph (AST parsing — no tokens spent)…");
      buildGraph().then((r) => controller.note(r), (e) => controller.note(`Graph build failed: ${e instanceof Error ? e.message : String(e)}`));
      return;
    }
    // Tracing is the one part of project understanding that spends tokens, so it is never started without
    // showing what it will cost and getting an answer. The estimate is computed first — planning is free.
    if (arg.trim().toLowerCase() === "trace") {
      if (!planTraces || !runTraces) { controller.note("Tracing is not available."); return; }
      void (async () => {
        try {
          const { summary, jobs } = await planTraces();
          if (!jobs) { controller.note(summary); return; }
          const answer = await controller.ask(`${summary}\n\nWrite the traces?`, {
            options: [
              { label: "Yes — write the traces", description: "Spends the tokens estimated above" },
              { label: "No", description: "Nothing is sent; the graph is unaffected" },
            ],
          });
          if (!/^yes/i.test(answer.trim())) { controller.note("Tracing cancelled — nothing was sent."); return; }
          controller.note(`Tracing ${jobs} file(s)…`);
          controller.note(await runTraces());
        } catch (e) {
          controller.note(`Tracing failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      })();
      return;
    }
    graphStatus().then((r) => controller.note(r), (e) => controller.note(`Graph status failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  // /skills [add <url> | update] → list what is loaded; add installs one from a repo; update re-installs them.
  const doSkills = (arg: string): void => {
    const add = /^add\s+(\S+)/i.exec(arg.trim());
    if (add) {
      if (!addSkill) { controller.note("Skill installation is not available."); return; }
      controller.note(`Installing from ${add[1]}…`);
      addSkill(add[1]).then(
        (r) => controller.note(r),
        (e) => controller.note(`Install failed: ${e instanceof Error ? e.message : String(e)}`),
      );
      return;
    }
    if (arg.trim().toLowerCase() === "add") {
      controller.note("Usage: `/skills add <github-url>` — e.g. `/skills add https://github.com/anthropics/skills/tree/main/skills/frontend-design`");
      return;
    }
    if (arg.trim().toLowerCase() === "update") {
      if (!updateSkills) { controller.note("Skill installation is not available."); return; }
      controller.note("Updating externally-sourced skills from upstream…");
      updateSkills().then(
        (r) => controller.note(r),
        (e) => controller.note(`Skill update failed: ${e instanceof Error ? e.message : String(e)}`),
      );
      return;
    }
    const all = listSkills?.() ?? [];
    if (!all.length) { controller.note("No skills loaded."); return; }
    const rows = all.map((s) => `- **${s.name}**${s.roles.length ? ` → \`${s.roles.join("`, `")}\`` : " _(discoverable)_"}\n  ${s.description}`);
    controller.note(`**Skills** (${all.length}):\n${rows.join("\n")}\n\n_\`/skills add <github-url>\` to install one · \`/skills update\` re-installs the ones sourced from a repo._`);
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
    else if (c.name === "/mcp") doMcp("");
    else if (c.name === "/sources") doSources("");
    else if (c.name === "/skills") doSkills("");
    else if (c.name === "/graph") doGraph("");
    else if (c.name === "/migrate") doMigrate();
    else if (c.name === "/continue-from-claude") doContinueFromClaude("");
    else if (c.name === "/mode") doMode("");
    else if (c.name === "/parallel") doParallel("");
    else if (c.name === "/monitor") doMonitor("");
    else if (c.name === "/watch") doWatch("");
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
  /**
   * Re-asserts raw mode, because a child process can take the terminal away from us.
   *
   * The tty is SHARED with everything the agents spawn. A child that configures it for itself — a dev server,
   * a watcher, anything that prompts — and is then killed rather than allowed to exit leaves the terminal in
   * ITS settings, not ours. Echo comes back on: from that moment every keystroke is printed by the terminal
   * below the last frame and wiped by the next repaint, which is exactly what a user reported after a task
   * whose job was to run `npm start`.
   *
   * Nothing tells us when it happens, so this checks. `isRaw` is the terminal's own answer, not a belief of
   * ours, and re-enabling when it is already on is a no-op.
   */
  useEffect(() => {
    const tty = rootStdin as (NodeJS.ReadStream & { isRaw?: boolean }) | undefined;
    if (!fullscreen || !tty?.isTTY || typeof tty.setRawMode !== "function") return undefined;
    const timer = setInterval(() => {
      if (tty.isRaw === false) tty.setRawMode(true);
    }, RAW_MODE_CHECK_MS);
    timer.unref?.(); // a repeating check must never be the reason the process stays alive
    return () => clearInterval(timer);
  }, [rootStdin, fullscreen]);
  const keyRef = useRef<(s: string) => void>(() => {});
  keyRef.current = (s: string): void => {
    // Help overlay owns stdin while open: Esc / q / ? closes it, everything else is swallowed.
    if (helpOpen) { if (closesHelp(s)) setHelpOpen(false); return; }
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
    /**
     * While agents are running, ↑/↓ walks THEM rather than the transcript.
     *
     * The transcript no longer carries their tool calls, so there is far less of it to scroll through and
     * far more to ask about the agents; PgUp/PgDn still scrolls, and Esc drops the highlight.
     */
    if (state.runningAgents.length > 0) {
      const kk = parseKittyKey(s);
      if (s === "\x1b" || kk?.type === "escape") { controller.clearAgentSelection(); return; }
      if (up) { controller.selectAgent(-1); return; }
      if (down) { controller.selectAgent(1); return; }
    }
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
        <ProgressView phase={state.phase} detail={state.detail} refinerModel={refinerModel?.()} meta={state.meta} cols={size.cols} live={state.liveActivity} />
        {state.pending ? <Prompt question={state.pending.question} onSubmit={(s) => controller.answer(s)} /> : null}
      </Box>
    );

  // Fullscreen (Claude Code model): flatten content into plain styled lines → manually render the
  // exactly-fitting window (no Ink overflow bug). The input is ALWAYS visible at the bottom; while a job
  // runs, a cyan status box sits above it and a metrics line below it. ↑/↓/PgUp/PgDn scrolls history.
  // Flattening the whole transcript on EVERY frame was half of the out-of-memory failure: the running-agent
  // panel ticks four times a second, and each tick rebuilt a full-length styled-line array for a transcript
  // that only changes when something is appended. Keyed on the transcript reference (the controller replaces
  // it on every append), so a tick now costs nothing. Hoisted out of the `fullscreen` branch — a hook inside a
  // conditional breaks React's hook order the moment that condition differs between renders.
  const fullscreenChatW = size.cols - 2;
  const fullscreenLines = useMemo<StyledLine[]>(() => [
    ...flattenSplash(fullscreenChatW, size.rows),
    ...state.transcript.flatMap((m) => ("kind" in m ? flattenTool(m.activity, fullscreenChatW) : flattenMessage(m.role, m.text, fullscreenChatW))),
  ], [state.transcript, fullscreenChatW, size.rows]);

  if (fullscreen) {
    // Chat content sits one unit off the left edge (paddingLeft below); flatten to the narrowed width so lines
    // still fit within the indented column and don't wrap early.
    const CHAT_INDENT = 2;
    const chatW = size.cols - CHAT_INDENT;
    const allLines = fullscreenLines;
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
    const choiceOptionsForFit = state.pending?.options ?? [];
    /**
     * How many rows the question's BODY may have.
     *
     * Everything else in the bottom region is fixed — the answer list above all, since a question whose
     * options are off-screen cannot be answered. Measured on a 20-row terminal: the body of a twelve-rule
     * question pushed both option labels out of the frame, and the user answered blind. So the body is given
     * whatever is left and elides the rest, rather than taking the space the options need.
     */
    const pendingBodyMax = state.pending
      ? Math.max(1, size.rows
        - 1 /* question header */ - 1 /* scroll hint */
        - (choiceOptionsForFit.length ? choiceHeight(choiceOptionsForFit, size.cols) : 2 + inputH)
        - (state.meta ? 2 : 0) - (state.queued > 0 ? 1 : 0)
        - 1 /* one row of transcript, so the question is not the whole screen */)
      : 0;
    const pendingLines = state.pending
      ? 1 + Math.min(
        flattenMarkdown(parsePending(state.pending.question).body, pendingBodyWidth(size.cols)).length,
        pendingBodyMax,
      )
      : 0;
    // The write indicator rides ON the progress line, so it costs no row of its own — and nothing is ever
    // drawn beneath the running indicator.
    const statusH = (progressLine || doneLine ? 1 : 0) + pendingLines; // progress/done(1) + pending
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
          ? inputMarginTop + choiceHeight(choiceOptions, size.cols)
          : 2 + inputMarginTop + inputH; // border(2) + marginTop + inputH
    const metricsH = state.meta ? 1 : 0;
    const metricsGapH = state.meta ? 1 : 0; // small blank line below the info line
    const queuedH = state.queued > 0 ? 1 : 0;
    /**
     * Live-agents panel under the input: a bordered box with a header and one row per agent, plus the detail
     * box for the highlighted one. Counted from the same shape the renderer draws — when the detail sits
     * BESIDE the list it costs no extra rows, and when it sits under it, it costs its own.
     */
    const selectedAgent = state.agentCursor !== undefined ? state.runningAgents[state.agentCursor] : undefined;
    const agentListH = state.runningAgents.length > 0 ? 3 + state.runningAgents.length : 0; // border(2) + header(1) + rows
    const detailLines = selectedAgent ? agentDetail(selectedAgent).length + 2 : 0; // + border(2)
    const agentsH = agentListH === 0 ? 0
      : size.cols - 2 >= 100 ? Math.max(agentListH, detailLines) // side by side → the taller of the two
        : agentListH + detailLines;
    // Counted from the same function that draws it — see agentDetail for what happens when those disagree.
    const showMonitor = monitorOn && (monitorReport !== undefined || watches.length > 0) && running;
    const monitorH = showMonitor
      ? monitorLines((monitorReport ?? { records: 0, stages: [], turns: 0, toolCalls: 0, singleToolTurns: 0,
        promptTokens: 0, modelSeconds: 0, reReads: [], errors: [], wroteNothing: [],
        inFlight: { count: 0, oldestMs: 0, models: [] } }) as MonitorReport, watches).length + 3
      : 0; // border(2) + title(1)
    const paletteH = slashOpen ? paletteHeight(slashCmds.length) : 0; // border(2) + windowed command rows + hint(1)
    const atH = atOpen ? Math.max(1, atMatches.length) + 3 : 0; // border(2) + file rows (min 1 for "no match") + hint(1)
    const nextH = 0; // suggestions live in the transcript now — see setNextSteps
    /**
     * Nothing optional may push the input box off the screen.
     *
     * The input, the status line and whatever the user just opened (the palette, the file picker) are fixed;
     * everything else is given up, in this order, until the frame fits. An agent panel nobody can type
     * underneath is worth less than the ability to type.
     */
    const keep = dropToFit(size.rows, statusH + paletteH + atH + inputBoxH + metricsH + queuedH + metricsGapH, [
      { name: "monitor", height: monitorH },
      { name: "next", height: nextH },
      { name: "agents", height: agentsH },
    ]);
    const bottomH = statusH + paletteH + atH + inputBoxH + metricsH + queuedH + metricsGapH
      + (keep.has("agents") ? agentsH : 0)
      + (keep.has("next") ? nextH : 0)
      + (keep.has("monitor") ? monitorH : 0);
    /**
     * While a question is pending, the transcript yields every row it can.
     *
     * The floor below is normally three rows of history, which is right when nothing is being asked. It is
     * wrong when something is: the question and its options are drawn at the top of the bottom region, so on
     * a terminal that cannot hold both, those three rows are taken from the QUESTION — which then scrolls off
     * the top and leaves the user answering something they cannot read.
     *
     * A long question must render. The history behind it can wait.
     */
    const viewportFloor = state.pending ? 0 : 3;
    const viewportH = Math.max(viewportFloor, size.rows - bottomH - 1); // -1: scroll hint line
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
            {progressLine ? <Box paddingLeft={2}><ProgressView phase={state.phase} detail={state.detail} refinerModel={refinerModel?.()} meta={state.meta} cols={size.cols} live={state.liveActivity} /></Box> : null}
            {doneLine ? <Box paddingLeft={2}><Text dimColor>{`${donePhrase(state.phase)} for ${fmtDuration(state.meta?.durationMs ?? 0)}${state.meta ? ` · ↑${fmtTokens(state.meta.promptTokens)} ↓${fmtTokens(state.meta.completionTokens)} · ${state.meta.calls} call${state.meta.calls === 1 ? "" : "s"}` : ""}`}</Text></Box> : null}
            {state.pending ? <PendingQuestion text={state.pending.question} cols={size.cols} maxLines={pendingBodyMax} /> : null}
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
              if (cmd.startsWith("/skills ")) { setScroll(0); setDraft(""); setDraftCursor(0); doSkills(trimmed.slice("/skills".length).trim()); return; }
              if (cmd.startsWith("/watch ")) { setScroll(0); setDraft(""); setDraftCursor(0); doWatch(trimmed.slice("/watch".length).trim()); return; }
              if (cmd.startsWith("/monitor ")) { setScroll(0); setDraft(""); setDraftCursor(0); doMonitor(trimmed.slice("/monitor".length).trim()); return; }
              if (cmd.startsWith("/parallel ")) { setScroll(0); setDraft(""); setDraftCursor(0); doParallel(trimmed.slice("/parallel".length).trim()); return; }
              if (cmd.startsWith("/mcp ")) { setScroll(0); setDraft(""); setDraftCursor(0); doMcp(trimmed.slice("/mcp".length).trim()); return; }
              if (cmd.startsWith("/graph ")) { setScroll(0); setDraft(""); setDraftCursor(0); doGraph(trimmed.slice("/graph".length).trim()); return; }
              if (cmd.startsWith("/continue-from-claude ")) { setScroll(0); setDraft(""); setDraftCursor(0); doContinueFromClaude(trimmed.slice("/continue-from-claude".length).trim()); return; }
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
        {state.meta ? <MetricsLine meta={state.meta} model={state.currentModel || coachModel?.() || model} /> : null}
        {state.runningAgents.length > 0 && keep.has("agents") ? <RunningAgents agents={state.runningAgents} cols={size.cols} cursor={state.agentCursor} /> : null}
        {showMonitor && keep.has("monitor") ? <RunMonitor
          report={(monitorReport ?? { records: 0, stages: [], turns: 0, toolCalls: 0, singleToolTurns: 0,
            promptTokens: 0, modelSeconds: 0, reReads: [], errors: [], wroteNothing: [],
        inFlight: { count: 0, oldestMs: 0, models: [] } }) as MonitorReport}
          watches={watches} cols={size.cols} /> : null}
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
