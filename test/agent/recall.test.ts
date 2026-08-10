import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Recall, recallNote, shellReadOnly, RECALLABLE } from "../../src/agent/recall.js";
import { executeToolCalls } from "../../src/agent/tool-exec.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import { readFileTool } from "../../src/tools/read.js";
import { writeFileTool } from "../../src/tools/write.js";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "hc-recall-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

/**
 * An agent asking for something it already has costs a whole model turn to be told what is already above it.
 *
 * Measured over one 577-minute run: 206 agents, 10,378 tool calls. Counting only repeats made INSIDE one
 * agent's own conversation, 1,141 of 6,743 reads and searches were identical to an earlier one — one in six.
 * The worst single agent spent 113 of its 300 calls that way, globbing `**\/safe-html.pipe.spec.ts` fifteen
 * times and reading `project.json` eight.
 */
describe("what an agent has already been shown", () => {
  it("remembers a call it answered, and says which turn answered it", () => {
    const r = new Recall();
    r.nextTurn();
    expect(r.saw("read_file", "path:a.ts")).toBeUndefined();
    r.note("read_file", "path:a.ts");
    expect(r.saw("read_file", "path:a.ts")).toBe(1);
  });

  it("keeps the FIRST turn, so the pointer sends the agent to where the content is", () => {
    const r = new Recall();
    r.nextTurn(); r.note("read_file", "path:a.ts");
    r.nextTurn(); r.note("read_file", "path:a.ts");
    expect(r.saw("read_file", "path:a.ts")).toBe(1);
  });

  /** A different range of the same file is a different question — see the key, which carries it. */
  it("does not confuse one page of a file with another", () => {
    const r = new Recall();
    r.nextTurn();
    r.note("read_file", "path:a.ts|limit=100|offset=1");
    expect(r.saw("read_file", "path:a.ts|limit=100|offset=101")).toBeUndefined();
  });

  /**
   * The memo is only true while the tree is unchanged. What a file said before an edit is not what it says
   * now, and answering from the old text is worse than the re-read it saved.
   */
  /**
   * A write forgets what it could have changed — the file it wrote, and nothing else.
   *
   * It used to clear the whole memo, which is true only of a write that could have touched anything. Writing
   * `plan.md` says nothing about `UpdateProduct.cs`, so everything the agent had learned about the rest of
   * the tree was thrown away on every write — and a planner that writes its plan repeatedly re-read the
   * codebase after each one.
   */
  it("forgets the file it wrote, and only that file", () => {
    const r = new Recall();
    r.nextTurn();
    r.note("read_file", "path:a.ts");
    r.note("read_file", "path:b.ts");
    r.note("grep", "pattern:x");
    r.note("edit_file", "path:b.ts");
    expect(r.saw("read_file", "path:b.ts")).toBeUndefined();   // …the one that changed
    expect(r.saw("read_file", "path:a.ts")).toBeDefined();     // …the ones that did not
    expect(r.saw("grep", "pattern:x")).toBeDefined();
  });

  /** Every page of the written file goes, not just the range that happens to match. */
  it("forgets every page of the file it wrote", () => {
    const r = new Recall();
    r.nextTurn();
    r.note("read_file", "path:a.ts|limit=40|offset=1");
    r.note("read_file", "path:a.ts|limit=40|offset=41");
    r.note("edit_file", "path:a.ts");
    expect(r.saw("read_file", "path:a.ts|limit=40|offset=1")).toBeUndefined();
    expect(r.saw("read_file", "path:a.ts|limit=40|offset=41")).toBeUndefined();
  });

  /**
   * A file the agent wrote IN FULL, it already has: the content is the text it passed to `write_file`.
   *
   * Measured on one planner: `specs/spec.md` read for 1,541,324 characters and `specs/plan.md` for
   * 1,366,926 — its own two documents, 58% of everything it read, in a run of 806 reads and 3 writes.
   */
  it("answers a read of what it wrote from its own write", () => {
    const r = new Recall();
    r.nextTurn();
    r.note("write_file", "path:plan.md");
    expect(r.recall("read_file", "path:plan.md")).toEqual({ turn: 1, authored: true });
    // …at any offset, because the whole file is what it wrote.
    expect(r.recall("read_file", "path:plan.md|limit=40|offset=200")?.authored).toBe(true);
  });

  /** …but a patch is not the file: after an edit it no longer holds the whole thing. */
  it("stops claiming to hold a file it has since only patched", () => {
    const r = new Recall();
    r.nextTurn();
    r.note("write_file", "path:plan.md");
    r.note("edit_file", "path:plan.md");
    expect(r.saw("read_file", "path:plan.md")).toBeUndefined();
  });

  it("treats a shell command that could write as a write", () => {
    const r = new Recall();
    r.nextTurn(); r.note("glob", "pattern:**/*.ts");
    r.note("shell", "rm -rf x");
    expect(r.saw("glob", "pattern:**/*.ts")).toBeUndefined();
  });

  /**
   * …but a shell command that only LOOKS must not, or the memo would be cancelled constantly: 298 of one
   * run's 1,216 shell commands were git, and 320 of the 356 verbs in them read nothing.
   */
  it("keeps the memo through a shell command that only looks", () => {
    const r = new Recall();
    r.nextTurn(); r.note("read_file", "path:a.ts");
    r.note("shell", "git status --short");
    r.note("shell", "ls && pwd");
    expect(r.saw("read_file", "path:a.ts")).toBe(1);
  });

  it("judges each segment, and disqualifies anything that could hide a write", () => {
    expect(shellReadOnly("git status")).toBe(true);
    expect(shellReadOnly("git -C toucan diff --stat")).toBe(true);
    expect(shellReadOnly("git status && git log -5")).toBe(true);
    expect(shellReadOnly("git status && npm ci")).toBe(false);       // …one bad segment is enough
    expect(shellReadOnly("git checkout package-lock.json")).toBe(false);
    expect(shellReadOnly("cat a.ts > b.ts")).toBe(false);            // …a redirection is a write
    expect(shellReadOnly("echo $(rm -rf x)")).toBe(false);           // …so is a substitution
    expect(shellReadOnly("nx build beempa")).toBe(false);            // …unrecognised means write
  });

  it("holds nothing for a tool whose answer is not the tree", () => {
    expect(RECALLABLE.has("read_file")).toBe(true);
    expect(RECALLABLE.has("submit")).toBe(false);
    const r = new Recall();
    r.nextTurn(); r.note("submit", "x");
    expect(r.saw("submit", "x")).toBeUndefined();
  });
});

describe("what the agent is told instead", () => {
  const note = recallNote("read_file", "safe-html.pipe.ts", 4);

  it("names the turn and the subject, so it can be looked up", () => {
    expect(note).toContain("turn 4");
    expect(note).toContain("safe-html.pipe.ts");
  });

  it("says the answer is unchanged, and leaves a way to ask again anyway", () => {
    expect(note).toMatch(/unchanged/i);
    expect(note).toMatch(/ask again/i);
  });
});

/** End to end: the second identical read must not reach the file system. */
describe("a repeated call in one conversation", () => {
  const deps = (recall: Recall, tools: ToolRegistry) => ({
    tools, permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true, cwd, signal: new AbortController().signal, recall,
  });
  const run = async (d: ReturnType<typeof deps>, name: string, args: unknown): Promise<string> => {
    const gen = executeToolCalls([{ id: "c1", name, arguments: JSON.stringify(args) }], d as never);
    let res = await gen.next();
    while (!res.done) res = await gen.next();
    return (res.value as { result: { content: string } }[])[0].result.content;
  };

  it("is answered with a pointer rather than the content", async () => {
    await writeFile(join(cwd, "a.ts"), "export const A = 1;\n", "utf8");
    const tools = new ToolRegistry();
    tools.register(readFileTool);
    const d = deps(new Recall(), tools);
    const first = await run(d, "read_file", { path: "a.ts" });
    expect(first).toContain("export const A = 1;");
    const second = await run(d, "read_file", { path: "a.ts" });
    expect(second).toMatch(/already answered/i);
    expect(second).not.toContain("export const A = 1;");
  });

  it("is answered afresh once the file has been written", async () => {
    await writeFile(join(cwd, "a.ts"), "old\n", "utf8");
    const tools = new ToolRegistry();
    tools.register(readFileTool);
    tools.register(writeFileTool);
    const d = deps(new Recall(), tools);
    await run(d, "read_file", { path: "a.ts" });
    await run(d, "write_file", { path: "a.ts", content: "new\n" });
    const again = await run(d, "read_file", { path: "a.ts" });
    // The agent wrote the whole file a call ago; it is pointed at its own text rather than handed it back.
    expect(again).toMatch(/you wrote/i);
    expect(again).not.toMatch(/already answered/i);
  });
});

/**
 * Two tools can name the same subject, and the memo must not confuse them.
 *
 * `read_file` and `edit_file` both key on the path, so `path:.specify/memory/constitution.md` is produced by
 * both — which is exactly what made a measurement of one run read as "the constitution was read three times"
 * when those three calls were edits. The memo is keyed by tool AND key, so nothing about that is ambiguous
 * here; this pins it, because the day it becomes ambiguous an agent is handed the wrong answer.
 */
describe("two tools, one subject", () => {
  it("does not answer a read from what a different tool did", () => {
    const r = new Recall();
    const key = "path:.specify/memory/constitution.md";
    r.note("read_file", key);
    expect(r.saw("read_file", key)).toBeDefined();
    // A tool that is not recallable never gets an answer from the memo, whatever it shares a key with.
    expect(r.saw("edit_file", key)).toBeUndefined();
    expect(r.saw("glob", key)).toBeUndefined();
  });

  /** …and the edit itself wipes the memo, so the next read sees the file as it is now. */
  it("forgets the read once the same path is edited", () => {
    const r = new Recall();
    const key = "path:.specify/memory/constitution.md";
    r.note("read_file", key);
    r.note("edit_file", key);
    expect(r.saw("read_file", key)).toBeUndefined();
  });

  /** Paging through a file is not repeating: each slice is its own question. */
  it("treats different slices of one file as different calls", () => {
    const r = new Recall();
    r.note("read_file", "path:doc.md|limit=160|offset=24");
    expect(r.saw("read_file", "path:doc.md|limit=50|offset=47")).toBeUndefined();
    expect(r.saw("read_file", "path:doc.md|limit=160|offset=24")).toBeDefined();
  });
});
