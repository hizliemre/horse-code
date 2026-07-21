import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { phaseLabel } from "./labels.js";

// Custom spinner: within a 4-cell track, a "0" (ball) moves back and forth (ping-pong): oo0o → ooo0 → …
// The track is dim "o"s, the ball "0" is bright brand blue.
const TRACK = 4;
const FRAMES: number[] = [0, 1, 2, 3, 2, 1]; // the ball's position (ping-pong)
const BALL = "#1a9fd8";
const DIM = "#3a5a68";

/** Left-aligned ping-pong spinner while a job is running (the "0" ball moves back and forth on the track). */
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

/** Left-aligned: spinner + phase label side by side. */
export function ProgressView({ phase, detail }: { phase: string; detail?: string; cols?: number }): React.ReactElement {
  return (
    <Box>
      <RunningHorse />
      <Text bold>{" "}{phaseLabel(phase)}{detail ? ` — ${detail}` : ""}</Text>
    </Box>
  );
}
