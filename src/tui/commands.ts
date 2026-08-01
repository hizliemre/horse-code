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
  { name: "/pin", desc: "Pin a fact for every turn (/pin <text>; /pin rm N)" },
  { name: "/pins", desc: "List the pinned facts for this project" },
  { name: "/remember", desc: "Remember a fact across sessions (/remember <text>)" },
  { name: "/memories", desc: "List remembered facts (/forget N to remove)" },
  { name: "/forget", desc: "Forget a remembered fact (/forget N)" },
  { name: "/mcp", desc: "Connected MCP servers (/mcp add <url|command> installs one and verifies it)" },
  { name: "/sources", desc: "Show your connected model sources (/sources refresh re-detects)" },
  { name: "/migrate", desc: "Bring a project from Claude Code / Codex / Cursor into horse-code (rules, memory, skills)" },
  { name: "/continue-from-claude", desc: "Continue work started in a Claude Code worktree (/continue-from-claude <name>) — its branch becomes the base" },
  { name: "/graph", desc: "Project code graph (/graph build · /graph trace) — what calls what, blast radius, per-file intent" },
  { name: "/skills", desc: "Show loaded skills (/skills add <github-url> installs one, /skills update re-installs them)" },
  { name: "/mode", desc: "Permission mode (/mode ask|acceptEdits|auto)" },
  { name: "/parallel", desc: "How many tasks run at once (/parallel N) — takes effect on the running job too" },
  { name: "/monitor", desc: "Where the run's time is going (/monitor enable shows the panel, disable hides it, log shows the file, heap writes a snapshot)" },
  { name: "/watch", desc: "Watch any command — each line it prints becomes an event (/watch <cmd>, /watch stop N)" },
  { name: "/help", desc: "List the available commands" },
  { name: "/clear", desc: "Clear the conversation" },
  { name: "/exit", desc: "Quit horse-code" },
];

/**
 * Commands whose name starts with the (trimmed, lowercased) draft — empty unless the draft starts with "/".
 *
 * Ordered SHORTEST FIRST, then alphabetically. Declaration order put `/model` above `/mode` for the query
 * "/mod": the exact word the user had finished typing sat under a longer command that merely extends it.
 * The shorter name is the one they have already fully typed, so it is the one they mean.
 */
export function matchCommands(draft: string): SlashCommand[] {
  const q = draft.trim().toLowerCase();
  if (!q.startsWith("/")) return [];
  return COMMANDS.filter((c) => c.name.startsWith(q))
    .sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
}

/** The text shown by /help (one line per command). */
export function helpText(): string {
  return COMMANDS.map((c) => `${c.name} — ${c.desc}`).join("\n");
}
