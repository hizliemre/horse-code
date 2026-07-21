// Slash commands available from the input. The palette (see SlashPalette) lists these and the App wires
// each name to an action. Keep the list here so adding a command is a one-line change.
export interface SlashCommand {
  name: string; // includes the leading "/"
  desc: string;
}

export const COMMANDS: SlashCommand[] = [
  { name: "/model", desc: "Switch the model for this session" },
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
