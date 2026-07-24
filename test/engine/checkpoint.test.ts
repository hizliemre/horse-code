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
});
