// Slash commands available from the input. The palette (see SlashPalette) lists these and the App wires
// each name to an action. Keep the list here so adding a command is a one-line change.
export interface SlashCommand {
  name: string; // includes the leading "/"
  desc: string;
}

// Only horse-code's own session commands belong here. The spec-kit phase commands (/specify, /plan, …)
// are internal pipeline steps, NOT user commands — surfacing them in the palette only confuses users.
export const COMMANDS: SlashCommand[] = [
  { name: "/model", desc: "Switch the model for this session" },
  { name: "/roles", desc: "Show roles and their models (/roles setmodel opens the picker)" },
  { name: "/sessions", desc: "List resumable sessions for this project" },
  { name: "/resume", desc: "Resume a past session (/resume N; /resume alone = most recent)" },
  { name: "/next", desc: "Run a suggested follow-up (/next N; /next alone lists them)" },
  { name: "/help", desc: "List the available commands" },
  { name: "/clear", desc: "Clear the conversation" },
  { name: "/exit", desc: "Quit horse-code" },
];

/** Commands whose name starts with the (trimmed, lowercased) draft — empty unless the draft starts with "/". */
export function matchCommands(draft: string): SlashCommand[] {
  const q = draft.trim().toLowerCase();
  if (!q.startsWith("/")) return [];
  return COMMANDS.filter((c) => c.name.startsWith(q));
}

/** The text shown by /help (one line per command). */
export function helpText(): string {
  return COMMANDS.map((c) => `${c.name} — ${c.desc}`).join("\n");
}
