/** Writes to the terminal (OSC sequences go out-of-band, not through Ink's frame). */
export type TitleWriter = (s: string) => void;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]; // braille spinner frames

/**
 * Animates the terminal tab/window title (OSC-0) so progress is visible when the terminal isn't focused:
 * a braille spinner + the active phase while working, the project name when idle. Disabled entirely when
 * `enabled` is false (e.g. HORSECODE_NO_TITLE=1).
 */
export class TerminalTitle {
  private timer?: ReturnType<typeof setInterval>;
  private frame = 0;
  private label = "";
  private readonly idleTitle: string;
  private readonly enabled: boolean;

  constructor(private readonly write: TitleWriter, opts: { idle: string; enabled?: boolean }) {
    this.idleTitle = opts.idle;
    this.enabled = opts.enabled ?? true;
    if (this.enabled) this.set(this.idleTitle);
  }

  private set(text: string): void {
    this.write(`\x1b]0;${text}\x07`); // OSC 0 ; <text> BEL → set icon name + window title
  }

  /** Show an animated spinner + label while working. Idempotent per label; keeps one interval running. */
  working(label: string): void {
    if (!this.enabled) return;
    this.label = label;
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % SPINNER.length;
        this.set(`${SPINNER[this.frame]} ${this.label}`);
      }, 120);
      if (typeof this.timer.unref === "function") this.timer.unref(); // don't keep the process alive
    }
    this.set(`${SPINNER[this.frame]} ${this.label}`); // paint immediately (don't wait for the first tick)
  }

  /** Stop the spinner and reset the title to the project name. */
  idle(): void {
    if (!this.enabled) return;
    this.clear();
    this.set(this.idleTitle);
  }

  /** Stop animating (on exit) — leaves the title at the idle value. */
  stop(): void {
    if (!this.enabled) return;
    this.clear();
    this.set(this.idleTitle);
  }

  private clear(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
