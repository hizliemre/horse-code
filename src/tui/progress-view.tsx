import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { phaseLabel } from "./labels.js";

const TRACK = 10;

/** Job işlenirken bir at (🐎) kısa bir pist üzerinde koşar; kareler timer ile döner. */
export function RunningHorse(): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => f + 1), 130);
    return () => clearInterval(id);
  }, []);
  const pos = frame % (TRACK + 1);
  return <Text color="cyan">{"·".repeat(pos)}🐎{"·".repeat(TRACK - pos)}</Text>;
}

/** Koşan at + dostça faz etiketi. */
export function ProgressView({ phase, detail }: { phase: string; detail?: string }): React.ReactElement {
  return (
    <Box>
      <RunningHorse />
      <Text>{"  "}</Text>
      <Text bold>{phaseLabel(phase)}</Text>
      {detail ? <Text dimColor>{` — ${detail}`}</Text> : null}
    </Box>
  );
}
