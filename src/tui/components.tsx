import React, { useEffect, useState } from "react";
import { Box, Text, useInput, Static } from "ink";
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

export function Message({ role, text }: { role: "user" | "assistant"; text: string }): React.ReactElement {
  return role === "user" ? (
    <Text><Text color="cyan" bold>{"› sen: "}</Text>{text}</Text>
  ) : (
    <Text><Text color="green" bold>{"🐴 hcode: "}</Text>{text}</Text>
  );
}

export function Splash(): React.ReactElement {
  return (
    <Box marginBottom={1}>
      <Box flexDirection="column" marginRight={2}>
        <Text color="yellow">{"  ▄██▄"}</Text>
        <Text color="yellow">{" ▟████▙"}</Text>
        <Text color="yellow">{"▟██████▙"}</Text>
        <Text color="yellow">{"▜███████"}</Text>
        <Text color="yellow">{" ▀▀▜███▙"}</Text>
        <Text color="yellow">{"     ▀██"}</Text>
      </Box>
      <Box flexDirection="column">
        <Text> </Text>
        <Text> </Text>
        <Text color="yellow" bold>{"H O R S E   C O D E"}</Text>
        <Text dimColor>{"çok-ajanlı kodlama mekanizması"}</Text>
      </Box>
    </Box>
  );
}

export function App({ controller }: { controller: TuiController }): React.ReactElement {
  const [state, setState] = useState(controller.getState());
  useEffect(() => controller.subscribe(() => setState(controller.getState())), [controller]);
  const mode = state.mode ?? "running";
  type Item = { kind: "splash" } | { kind: "msg"; role: "user" | "assistant"; text: string };
  const items: Item[] = [
    { kind: "splash" },
    ...state.transcript.map((m) => ({ kind: "msg" as const, role: m.role, text: m.text })),
  ];
  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item, i) =>
          item.kind === "splash" ? (
            <Splash key={i} />
          ) : (
            <Message key={i} role={item.role} text={item.text} />
          )
        }
      </Static>
      {mode === "input" ? (
        <Box flexDirection="column">
          <Text dimColor>Görevini yaz (Ctrl+C çıkış)</Text>
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
