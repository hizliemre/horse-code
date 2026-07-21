import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { phaseLabel } from "./labels.js";

// Küçük pixel-art at, yerinde gallop: gövde/baş sabit, bacaklar kare-kare değişir.
const HORSE_FRAMES: [string, string][] = [
  ["▟▀▜▙▖", "▘  ▝ "],
  ["▟▀▜▙▖", "▖  ▗ "],
  ["▟▀▜▙▖", "▝  ▘ "],
  ["▟▀▜▙▖", "▗  ▖ "],
];

/** Job işlenirken küçük pixel-art at yerinde koşar (timer ile kare döner). */
export function RunningHorse(): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % HORSE_FRAMES.length), 140);
    return () => clearInterval(id);
  }, []);
  const [body, legs] = HORSE_FRAMES[frame];
  return (
    <Box flexDirection="column">
      <Text color="#1a9fd8">{body}</Text>
      <Text color="#1a9fd8">{legs}</Text>
    </Box>
  );
}

/** Koşan at + dostça faz etiketi (yan yana, etiket at hizasında). */
export function ProgressView({ phase, detail }: { phase: string; detail?: string }): React.ReactElement {
  return (
    <Box>
      <RunningHorse />
      <Box marginLeft={1} flexDirection="column">
        <Text> </Text>
        <Text bold>{phaseLabel(phase)}{detail ? ` — ${detail}` : ""}</Text>
      </Box>
    </Box>
  );
}
