import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { phaseLabel } from "./labels.js";

// Özgün spinner: 4'lük track içinde bir "0" (top) sağa-sola gidip gelir (ping-pong): oo0o → ooo0 → …
// Track küçük "o"lar (sönük), top "0" parlak marka mavisi.
const TRACK = 4;
const FRAMES: number[] = [0, 1, 2, 3, 2, 1]; // topun pozisyonu (ping-pong)
const BALL = "#1a9fd8";
const DIM = "#3a5a68";

/** Job işlenirken sola-dayalı ping-pong spinner (0 top track'te gidip gelir). */
export function RunningHorse(): React.ReactElement {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % FRAMES.length), 110);
    return () => clearInterval(id);
  }, []);
  const pos = FRAMES[i];
  return (
    <Text>
      {Array.from({ length: TRACK }, (_, x) =>
        x === pos ? (
          <Text key={x} color={BALL} bold>0</Text>
        ) : (
          <Text key={x} color={DIM}>o</Text>
        ),
      )}
    </Text>
  );
}

/** Sola-dayalı: spinner + faz etiketi yan yana. */
export function ProgressView({ phase, detail }: { phase: string; detail?: string; cols?: number }): React.ReactElement {
  return (
    <Box>
      <RunningHorse />
      <Text bold>{" "}{phaseLabel(phase)}{detail ? ` — ${detail}` : ""}</Text>
    </Box>
  );
}
