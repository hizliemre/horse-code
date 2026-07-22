import { describe, it, expect, afterEach } from "vitest";
import { TerminalTitle } from "../../src/tui/terminal-title.js";

const osc = (s: string): string | undefined => {
  const m = s.match(/^\x1b\]0;(.*)\x07$/);
  return m ? m[1] : undefined;
};

let live: TerminalTitle | undefined;
afterEach(() => { live?.stop(); live = undefined; });

describe("TerminalTitle", () => {
  it("sets the idle title on construction", () => {
    const out: string[] = [];
    live = new TerminalTitle((s) => out.push(s), { idle: "horse-code — myproj" });
    expect(out.map(osc)).toEqual(["horse-code — myproj"]);
  });

  it("working() paints a spinner + label immediately; idle() resets to the project name", () => {
    const out: string[] = [];
    live = new TerminalTitle((s) => out.push(s), { idle: "proj" });
    out.length = 0;
    live.working("refining");
    const painted = osc(out[out.length - 1]) ?? "";
    expect(painted).toContain("refining");
    expect(painted).toMatch(/^[⠀-⣿] /); // starts with a braille spinner glyph + space
    out.length = 0;
    live.idle();
    expect(osc(out[out.length - 1])).toBe("proj");
  });

  it("writes nothing when disabled", () => {
    const out: string[] = [];
    live = new TerminalTitle((s) => out.push(s), { idle: "proj", enabled: false });
    live.working("x");
    live.idle();
    expect(out).toEqual([]);
  });
});
