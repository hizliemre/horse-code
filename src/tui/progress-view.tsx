import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { phaseLabel } from "./labels.js";

// Per-phase accent: refine keeps the brand blue; the coach-waiting phase turns orange.
const BLUE = "#1a9fd8";
const ORANGE = "#e8912d";
const DIM = "#5a6b72"; // neutral dim for the un-lit characters / track
function accentFor(phase: string): string {
  return phase === "chat" ? ORANGE : BLUE;
}

// Ping-pong ball spinner: within a 4-cell track, a "0" ball moves back and forth (oo0o → ooo0 → …).
const TRACK = 4;
const BALL_FRAMES: number[] = [0, 1, 2, 3, 2, 1];

/** Left-aligned ping-pong spinner; the ball is tinted with the phase accent. */
export function RunningHorse({ accent = BLUE }: { accent?: string }): React.ReactElement {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % BALL_FRAMES.length), 110);
    return () => clearInterval(id);
  }, []);
  const pos = BALL_FRAMES[i];
  return (
    <Text>
      {Array.from({ length: TRACK }, (_, x) =>
        x === pos ? (
          <Text key={x} color={accent} bold>0</Text>
        ) : (
          <Text key={x} color={DIM}>o</Text>
        ),
      )}
    </Text>
  );
}

/**
 * Claude/WrongStack-style shimmer: a bright highlight sweeps back and forth (ping-pong) across dim text.
 * The lit head is the accent color; the two neighbours are a softer accent; everything else is dim.
 */
export function ShimmerText({ text, accent = BLUE, bold = true }: { text: string; accent?: string; bold?: boolean }): React.ReactElement {
  const chars = [...text];
  const span = Math.max(1, chars.length - 1);
  // Head sweeps 0…span…0 (ping-pong). One frame per cell → the light travels one character per tick.
  const frames = span * 2;
  const [f, setF] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setF((n) => (n + 1) % frames), 90);
    return () => clearInterval(id);
  }, [frames]);
  const head = f <= span ? f : frames - f; // 0→span→0
  return (
    <Text>
      {chars.map((c, i) => {
        const d = Math.abs(i - head);
        if (c === " ") return <Text key={i}> </Text>;
        if (d === 0) return <Text key={i} color={accent} bold={bold}>{c}</Text>;
        if (d <= 2) return <Text key={i} color={accent}>{c}</Text>;
        return <Text key={i} color={DIM}>{c}</Text>;
      })}
    </Text>
  );
}

/** Left-aligned: ping-pong ball + shimmering phase label. During refine the label shows the refiner model. */
export function ProgressView(
  { phase, detail, refinerModel }: { phase: string; detail?: string; cols?: number; refinerModel?: string },
): React.ReactElement {
  const accent = accentFor(phase);
  // The refiner model is shown ONLY here, alongside the refine status (never in the model line under the input).
  const suffix = phase === "upstream" && refinerModel ? ` (${refinerModel})` : detail ? ` — ${detail}` : "";
  return (
    <Box>
      <RunningHorse accent={accent} />
      <Text> </Text>
      <ShimmerText text={`${phaseLabel(phase)}${suffix}`} accent={accent} />
    </Box>
  );
}
