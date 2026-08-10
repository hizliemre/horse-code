import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCheckpoint, writeCheckpoint, clearCheckpoint, checkpointKey, isContinuePrompt, type Checkpoint } from "../../src/engine/checkpoint.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const sample: Checkpoint = {
  rawPrompt: "Build a todo app",
  refinedPrompt: "Build a todo application with add/complete/delete",
  title: "Todo App",
  language: "English",
  featureSlug: "001-todo-app",
  done: ["constitution", "spec"],
};

describe("checkpoint read/write/clear", () => {
  it("round-trips a checkpoint written to a worktree root", async () => {
    dir = await mkdtemp(join(tmpdir(), "hc-cp-"));
    expect(readCheckpoint(dir)).toBeNull(); // none yet
    writeCheckpoint(dir, sample);
    expect(existsSync(join(dir, "checkpoint.json"))).toBe(true);
    expect(readCheckpoint(dir)).toEqual(sample);
    clearCheckpoint(dir);
    expect(readCheckpoint(dir)).toBeNull();
  });

  it("returns null for a corrupt / non-object checkpoint instead of throwing", async () => {
    dir = await mkdtemp(join(tmpdir(), "hc-cp-"));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "checkpoint.json"), "{ not json", "utf8");
    expect(readCheckpoint(dir)).toBeNull();
    writeFileSync(join(dir, "checkpoint.json"), JSON.stringify({ done: "nope" }), "utf8"); // done not an array
    expect(readCheckpoint(dir)).toBeNull();
  });
});

describe("checkpointKey", () => {
  it("is tolerant of whitespace + case so a retyped prompt still matches", () => {
    expect(checkpointKey("  Build A  Todo\napp ")).toBe(checkpointKey("build a todo app"));
    expect(checkpointKey("Build a todo app")).not.toBe(checkpointKey("Build a chat app"));
  });
});

describe("isContinuePrompt", () => {
  it("flags short 'continue' requests in Turkish + English", () => {
    for (const t of ["kaldığımız yerden devam edelim.", "devam", "devam et", "continue", "resume", "kaldığın yerden devam et", "keep going", "carry on"]) {
      expect(isContinuePrompt(t)).toBe(true);
    }
  });
  it("does NOT flag a real task, even one that mentions resume/continue", () => {
    expect(isContinuePrompt("Build a todo app")).toBe(false);
    expect(isContinuePrompt("Add a button that lets the user resume a paused download from the last byte offset")).toBe(false); // long → real task
    expect(isContinuePrompt("implement session persistence")).toBe(false);
  });

  /**
   * A request that says WHAT to continue is not a bare continue — it is a request, and it has to reach the
   * refiner to be classified.
   *
   * This was a length test: under sixty characters and containing "devam" meant "resume the last worktree".
   * Turkish puts the continuation word at the END, so naming a subject in front of it stays well inside sixty
   * — and a real request was answered with "there is no preserved work to continue", never reaching intent
   * classification at all. The distinction was never length; it is whether anything but the continuing is
   * being said.
   */
  it("does NOT flag a request that names what to continue", () => {
    expect(isContinuePrompt("ürün yaratma sihirbazının testlerine devam edeceğiz.")).toBe(false);
    expect(isContinuePrompt("PR 677'nin test adımlarına devam et")).toBe(false);
    expect(isContinuePrompt("continue the checkout tests")).toBe(false);
    expect(isContinuePrompt("resume the wallet migration")).toBe(false);
  });

  /** …while the ways a person actually says "just carry on" keep working, filler and all. */
  it("still flags a bare continue however it is padded", () => {
    for (const t of [
      "devam edelim lütfen", "hadi devam", "devam et bakalım", "tamam devam",
      "let's continue where we left off", "ok, keep going", "please resume",
    ]) {
      expect(isContinuePrompt(t), t).toBe(true);
    }
  });
});

describe("checkpoint carries the deferred notes", () => {
  it("round-trips carryOver so a restart does not lose earlier reviews' non-blocking findings", async () => {
    dir = await mkdtemp(join(tmpdir(), "hc-cp-"));
    const cp: Checkpoint = { ...sample, carryOver: ["[spec][medium] spec-scope: trim the v1 surface"] };
    writeCheckpoint(dir, cp);
    expect(readCheckpoint(dir)?.carryOver).toEqual(["[spec][medium] spec-scope: trim the v1 surface"]);
  });
});

/**
 * Resuming is matched on the ORIGINAL request or a bare "continue". A follow-up that corrects course — "I
 * answered that wrongly, we need to fix it" — matches neither, so the pipeline silently started over from
 * the constitution while the preserved work sat next to it. The REPL now asks; these are the inputs that
 * decide whether it needs to.
 */
describe("isContinuePrompt decides when resuming is unambiguous", () => {
  it("recognises a bare continue, in either language", () => {
    for (const t of ["devam", "devam edelim", "continue", "resume", "kaldığımız yerden devam"]) {
      expect(isContinuePrompt(t)).toBe(true);
    }
  });

  /** The message that caused the loss: a correction, not a continuation — so the REPL has to ask. */
  it("does NOT treat a course-correction as a continuation", () => {
    expect(isContinuePrompt("todoya ekleme. yanlış cevap verdim. sorunu düzeltmemiz gerekiyor")).toBe(false);
  });

  it("does not mistake a long request that happens to contain the word", () => {
    const long = "continue building the wizard but first refactor the slider component and its tests thoroughly";
    expect(isContinuePrompt(long)).toBe(false);
  });
});

/**
 * A resumed session keeps what it WAS.
 *
 * The checkpoint exists so a resume needs no refiner — it carries the refined prompt, the title and the
 * language. It forgot the one field that decides what happens next, so `runUpstream` hardcoded `feature` for
 * every resume. Reported live: a verification session resumed with "devam" answered "Writing the feature
 * spec", then produced a constitution and a brainstorm for a request whose whole output was a test report.
 */
describe("the checkpoint remembers what the work is", () => {
  it("round-trips the intent", async () => {
    dir = await mkdtemp(join(tmpdir(), "hc-cp-"));
    writeCheckpoint(dir, { ...sample, intent: "verify" });
    expect(readCheckpoint(dir)?.intent).toBe("verify");
  });

  it("reads as feature when the checkpoint predates the field — the old behaviour, unchanged", async () => {
    dir = await mkdtemp(join(tmpdir(), "hc-cp-"));
    writeCheckpoint(dir, sample);                       // no intent: written before this existed
    const back = readCheckpoint(dir);
    expect(back?.intent).toBeUndefined();
    expect(back?.intent ?? "feature").toBe("feature");   // …and that is how upstream reads it
  });

  it("carries a govern session's intent too, not only verify", async () => {
    dir = await mkdtemp(join(tmpdir(), "hc-cp-"));
    writeCheckpoint(dir, { ...sample, intent: "govern", lane: "govern" });
    expect(readCheckpoint(dir)?.intent).toBe("govern");
  });
});

/**
 * The lie that made it worse: `laneFor` trusts the intent it is given, and on the resume path that intent
 * was a constant. With the checkpoint's own intent restored, a resumed verification routes to verify without
 * needing the prompt to be a bare "devam".
 */
describe("what upstream does with a resumed intent", () => {
  const src = async (): Promise<string> =>
    (await import("node:fs/promises")).readFile("src/engine/upstream.ts", "utf8");

  it("no longer hardcodes feature on the resume path", async () => {
    const s = await src();
    expect(s).not.toContain('{ intent: "feature" as Intent, refinedPrompt: resume.refinedPrompt');
    expect(s).toContain('intent: resume.intent ?? ("feature" as Intent)');
  });

  it("writes the intent into both the lane checkpoint and the pipeline one", async () => {
    const s = await src();
    expect(s).toContain("done: [], lane, intent: r.intent,");
    expect(s).toContain("language: r.language, intent: r.intent, featureSlug: slug");
  });
});
