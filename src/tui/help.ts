import { COMMANDS } from "./commands.js";

export interface HelpEntry {
  keys: string; // the key or chord (e.g. "Ctrl+C", "↑ / ↓")
  desc: string;
}
export interface HelpSection {
  title: string;
  entries: HelpEntry[];
}

/** Data-driven help content (rendered by the `?` overlay). Pure → unit-testable, never drifts silently. */
export function helpSections(): HelpSection[] {
  return [
    {
      title: "Editing",
      entries: [
        { keys: "Enter", desc: "Send the message" },
        { keys: "Shift/Alt+Enter", desc: "Insert a new line" },
        { keys: "↑ / ↓", desc: "Command history (empty input)" },
        { keys: "Ctrl+A / Ctrl+E", desc: "Jump to line start / end" },
        { keys: "Ctrl+← / Ctrl+→", desc: "Move by word" },
        { keys: "Ctrl+W", desc: "Delete the word before the cursor" },
        { keys: "Ctrl+U / Ctrl+K", desc: "Kill to line start / end" },
        { keys: "Alt+V", desc: "Paste an image from the clipboard" },
        { keys: "@", desc: "Fuzzy-find a project file into the prompt" },
      ],
    },
    {
      title: "Navigation",
      entries: [
        { keys: "PgUp / PgDn", desc: "Scroll the transcript" },
        { keys: "→ / Tab", desc: "Complete the highlighted slash command" },
        { keys: "Esc", desc: "Cancel a panel / dismiss a choice" },
        { keys: "Ctrl+C", desc: "Cancel the run · press twice (fast) to quit from anywhere" },
        { keys: "?", desc: "This help (Esc / q / ? to close)" },
      ],
    },
    {
      title: "Commands",
      entries: COMMANDS.map((c) => ({ keys: c.name, desc: c.desc })),
    },
  ];
}
