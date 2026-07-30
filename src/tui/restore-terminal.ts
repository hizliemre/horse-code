/**
 * Puts the terminal back the way it was found.
 *
 * A TUI borrows the terminal: raw mode (no line editing, no echo, no signal keys), the alternate screen, the
 * cursor, bracketed paste, the kitty keyboard protocol. Every one of those has to be handed back, and the
 * handing back is easy to skip — `process.exit()` does not unmount Ink, so Ink's own cleanup never runs.
 *
 * Reported after a real session: quitting left the shell echoing `^M` for Enter and `^C` for interrupt, with
 * commands typed as `clear^M^C^C^C…` and never executed. That is a terminal still in raw mode: the shell was
 * receiving keystrokes it was never meant to interpret.
 *
 * Written to be safe to call from anywhere, any number of times, including from an `exit` handler where
 * nothing async can run.
 */

/** The escape sequences the TUI turns on, in reverse: paste mode, kitty protocol, alt-screen, cursor. */
export const RESET_SEQUENCE = "\x1b[?2004l\x1b[<u\x1b[?1049l\x1b[?25h";

export interface TerminalHandles {
  /** Structural, not `NodeJS.ReadStream`: the only thing that matters is whether it can leave raw mode. */
  stdin: { isTTY?: boolean; setRawMode?: (raw: boolean) => unknown };
  write: (s: string) => unknown;
}

/**
 * Restores cooked mode and undoes the display modes. Never throws.
 *
 * Raw mode first: it is the one whose absence makes the shell unusable, so it must not be skipped by a write
 * that fails on a closed stream.
 */
export function restoreTerminal(h: TerminalHandles): void {
  try {
    if (h.stdin.isTTY && typeof h.stdin.setRawMode === "function") h.stdin.setRawMode(false);
  } catch {
    // A stream that is already gone needs nothing put back.
  }
  try {
    h.write(RESET_SEQUENCE);
  } catch {
    // Same.
  }
}

/**
 * Registers the restore on every way out.
 *
 * `exit` covers a plain return and an explicit `process.exit`. The signals are separate because Node's
 * default handler for them does NOT run `exit` handlers — a Ctrl+C that reaches the process, or a `kill`,
 * would otherwise leave the terminal raw. Returns a function that removes them again.
 */
export function restoreOnExit(h: TerminalHandles, proc: NodeJS.Process = process): () => void {
  const onExit = (): void => restoreTerminal(h);
  const onSignal = (sig: NodeJS.Signals) => (): void => {
    restoreTerminal(h);
    // Re-raise with the default handler so the exit code and the parent's view of it stay honest.
    proc.removeListener(sig, onSignal(sig));
    proc.kill(proc.pid, sig);
  };
  const sigint = onSignal("SIGINT");
  const sigterm = onSignal("SIGTERM");
  const sighup = onSignal("SIGHUP");
  proc.once("exit", onExit);
  proc.once("SIGINT", sigint);
  proc.once("SIGTERM", sigterm);
  proc.once("SIGHUP", sighup);
  return () => {
    proc.removeListener("exit", onExit);
    proc.removeListener("SIGINT", sigint);
    proc.removeListener("SIGTERM", sigterm);
    proc.removeListener("SIGHUP", sighup);
  };
}
