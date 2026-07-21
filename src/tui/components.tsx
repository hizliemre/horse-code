import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { BoardCardView } from "../engine/progress.js";
import type { Column } from "../board/board.js";
import type { TuiController } from "./controller.js";

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

export function Prompt({ question, onSubmit }: { question: string; onSubmit: (s: string) => void }): React.ReactElement {
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
  return (
    <Box flexDirection="column">
      <Text>{question}</Text>
      <Text>{"> "}{buf}</Text>
    </Box>
  );
}

export function App({ controller }: { controller: TuiController }): React.ReactElement {
  const [state, setState] = useState(controller.getState());
  useEffect(() => controller.subscribe(() => setState(controller.getState())), [controller]);
  const mode = state.mode ?? "running";
  if (mode === "input") {
    return (
      <Box flexDirection="column">
        {state.lastReport ? <Text>{state.lastReport}</Text> : null}
        <Prompt question="Görevini yaz (Ctrl+C çıkış):" onSubmit={(t) => controller.submitTask(t)} />
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <PhaseBar phase={state.phase} detail={state.detail} />
      <Board cards={state.cards} />
      {state.pending ? <Prompt question={state.pending.question} onSubmit={(s) => controller.answer(s)} /> : null}
    </Box>
  );
}
