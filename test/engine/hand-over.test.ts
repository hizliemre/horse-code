import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

/**
 * The implementer is the one participant that cannot know whether the work is done.
 *
 * Measured live: the card read `coder small-1 — Uygulama tamamlandı.` ("implementation complete"), and the
 * very next thing on the screen was four review lenses opening the same diff — two of them rejecting it —
 * and a five-member council voting on what to do about it. Reported by the user watching: "uygulama
 * tamamlandı dedi ama sonrasında review'e başladı. review bitmeden uygulama tamamlandı dememeli."
 *
 * A source assertion, not a behavioural one: what closes an implementer's turn is prose from a model, and
 * the only place this can be decided is the instruction it was given.
 */
describe("what an implementer is told about stopping", () => {
  const src = (): Promise<string> => readFile("src/engine/implementer.ts", "utf8");

  it("calls it a hand-over, and names who decides instead", async () => {
    const s = await src();
    expect(s).toContain("you are HANDING the change over");
    expect(s).toContain("a review and an acceptance check that have not run");
    expect(s.replace(/`\s*\+\s*`/g, "")).toContain("do not write that the task is complete, done or finished");
  });

  it("still asks for what it changed and what it ran — the part that IS its to say", async () => {
    expect(await src()).toContain("close with what you changed and what you ran");
  });

  it("reaches the implementer's own message, not just the file", async () => {
    const s = await src();
    expect(s).toContain("${hygiene}\\n\\n${handOver}");
  });
});

/**
 * The tool was there, the instruction was there, and it was used zero times.
 *
 * Measured over one whole run: 153 tool calls by a single implementer, ten of them failed shell commands
 * working out that this project's formatter has to be invoked from a subdirectory — and not one
 * `remember_fact`. The next run pays for all of it again.
 *
 * A standing offer in the system prompt is not a moment. The close of the turn is one, and it is the last
 * one there is — so it carries the check, while the instruction itself still says to write it when it is
 * learned. A run stopped early must still leave behind what it paid for.
 */
describe("what an implementer is asked before it stops", () => {
  const src = (f: string): Promise<string> => readFile(f, "utf8");

  it("asks whether anything cost more than one attempt, and to record it", async () => {
    const s = await src("src/engine/implementer.ts");
    expect(s).toContain("did anything here cost you more than one attempt");
    expect(s).toContain("remember_fact");
    expect(s).toContain("The next agent pays for it again otherwise.");
  });

  it("still tells every role holding the tool to write it AS it is learned", async () => {
    const s = await src("src/engine/task-types.ts");
    expect(s).toContain("A SECOND failure of the same kind is the trigger");
    expect(s).toContain("Write it before you carry on");
  });
});

/**
 * Git is this tool's job, and it was handed back to the person.
 *
 * Measured live, under a heading the agent wrote itself — "Geliştiriciye kalan" ("left for the developer"):
 * "1. SCSS dosyasını `git add` ile stage'e al — şu an untracked". Reported in one line: "geliştiriciye neden
 * git add işini bıraktığını söylüyor? bu bir otonom coding aracı."
 *
 * Right twice over. Staging is not a decision anyone should be asked to make, and an untracked file is
 * invisible to `git diff` — so the review judges the change with a hole in it, and nobody knows which hole.
 */
describe("what is never asked of the developer", () => {
  /** Prompt text is assembled from concatenated template pieces; join them before matching. */
  const prose = async (f: string): Promise<string> =>
    (await readFile(f, "utf8")).replace(/`\s*\+\s*`/g, "");

  it("does not hand git over — not from an implementer", async () => {
    const s = await prose("src/engine/implementer.ts");
    expect(s).toContain("Staging, committing and branches are this tool's business, never the developer's");
    expect(s).toContain("that is a fault to report, not an errand to hand over");
  });

  it("…nor from the tester, which talks to them the most", async () => {
    const s = await prose("src/engine/verify.ts");
    expect(s).toContain("Staging, committing and branches are this tool's business, never the developer's");
    // …and what it MAY still ask for is named, so the rule does not read as "ask them nothing".
    expect(s).toContain("carry out a scenario, look at a screen, start an environment");
  });

  /**
   * The other half: a file the tool wrote must be IN git, or the review is judging a hole.
   *
   * The first attempt at "no checkpoints outside a worktree" asked `deps.baseRef`, and was wrong by exactly
   * one lane — the verify lane's fixer runs inside a session worktree and is handed no base, so its writes
   * stopped being committed and a file it created stayed untracked. The question is WHERE the work is.
   */
  it("commits a checkpoint wherever the work is ours, not wherever a base ref was passed", async () => {
    const s = await readFile("src/engine/operational.ts", "utf8");
    expect(s).toContain("if (writableStateRoot(workdir) === undefined) return undefined;");
    expect(s).not.toContain("if (!deps.baseRef) return undefined;");
  });
});
