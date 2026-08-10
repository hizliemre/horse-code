import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  planTraces, tracePrompt, saveTrace, pruneTraces, loadTraceIndex, saveTraceIndex,
  readTraceSync, tracePath, hashContent, MAX_TRACE_FILE_CHARS, ensureGitignore, GITIGNORE_MARKER,
  traceCoverage, setTraceRoot,
} from "../../src/engine/trace.js";
import type { TraceIndex } from "../../src/engine/trace.js";
import { describePlan, runTraces } from "../../src/engine/trace-run.js";
import { parseGraph } from "../../src/engine/project-graph.js";
import type { Provider } from "../../src/core/types.js";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "hc-trace-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

const write = async (file: string, body: string): Promise<void> => {
  await mkdir(join(cwd, file, ".."), { recursive: true });
  await writeFile(join(cwd, file), body, "utf8");
};

const GRAPH = parseGraph(JSON.stringify({
  nodes: [
    { id: "a", label: "alpha()", source_file: "src/a.ts" },
    { id: "b", label: "beta()", source_file: "src/b.ts" },
  ],
  links: [{ source: "b", target: "a", relation: "calls" }],
}));

const empty = (): TraceIndex => ({ version: 1, traces: {} });

describe("planTraces — the estimate the user approves", () => {
  it("plans one job per traceable file", async () => {
    await write("src/a.ts", "export const a = 1;");
    await write("src/b.ts", "export const b = 2;");
    const plan = await planTraces(cwd, ["src/a.ts", "src/b.ts"], GRAPH, empty());
    expect(plan.jobs.map((j) => j.file)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(plan.estimatedInputTokens).toBeGreaterThan(0);
    expect(plan.estimatedOutputTokens).toBe(plan.jobs.length * 350);
  });

  // The whole reason traces are affordable to maintain: an unchanged file is never paid for twice.
  it("skips a file whose trace is current", async () => {
    await write("src/a.ts", "export const a = 1;");
    const index = empty();
    index.traces["src/a.ts"] = { hash: hashContent("export const a = 1;"), file: "src/a.ts", writtenAt: 1 };
    await saveTrace(cwd, { file: "src/a.ts", hash: "x", content: "", symbols: [], usedBy: [], uses: [] }, "body");
    const plan = await planTraces(cwd, ["src/a.ts"], GRAPH, index);
    expect(plan.jobs).toHaveLength(0);
    expect(plan.upToDate).toBe(1);
  });

  it("re-plans a file whose content changed", async () => {
    await write("src/a.ts", "export const a = 999;");
    const index = empty();
    index.traces["src/a.ts"] = { hash: hashContent("export const a = 1;"), file: "src/a.ts", writtenAt: 1 };
    const plan = await planTraces(cwd, ["src/a.ts"], GRAPH, index);
    expect(plan.jobs).toHaveLength(1);
  });

  // An index entry whose file was deleted must not count as up to date — the trace would never be rewritten.
  it("re-plans when the index claims a trace that is not on disk", async () => {
    await write("src/a.ts", "export const a = 1;");
    const index = empty();
    index.traces["src/a.ts"] = { hash: hashContent("export const a = 1;"), file: "src/a.ts", writtenAt: 1 };
    const plan = await planTraces(cwd, ["src/a.ts"], GRAPH, index);
    expect(plan.jobs).toHaveLength(1);
  });

  it("skips a file too large to trace economically, and says so", async () => {
    await write("src/huge.ts", "x".repeat(MAX_TRACE_FILE_CHARS + 1));
    const plan = await planTraces(cwd, ["src/huge.ts"], GRAPH, empty());
    expect(plan.jobs).toHaveLength(0);
    expect(plan.skipped[0].file).toBe("src/huge.ts");
  });

  it("ignores an empty file", async () => {
    await write("src/empty.ts", "   \n");
    expect((await planTraces(cwd, ["src/empty.ts"], GRAPH, empty())).jobs).toHaveLength(0);
  });

  it("carries the graph relationships into the job", async () => {
    await write("src/a.ts", "export const a = 1;");
    const plan = await planTraces(cwd, ["src/a.ts"], GRAPH, empty());
    expect(plan.jobs[0].symbols).toContain("alpha()");
    expect(plan.jobs[0].usedBy).toContain("src/b.ts");
  });

  it("works without a graph at all", async () => {
    await write("src/a.ts", "export const a = 1;");
    const plan = await planTraces(cwd, ["src/a.ts"], undefined, empty());
    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0].usedBy).toEqual([]);
  });
});

describe("the consent text", () => {
  it("states the file count, the model and both token figures", async () => {
    await write("src/a.ts", "x".repeat(4000));
    const plan = await planTraces(cwd, ["src/a.ts"], GRAPH, empty());
    const text = describePlan(plan, "cheap-model");
    expect(text).toContain("cheap-model");
    expect(text).toMatch(/Tracing 1 file/);
    expect(text).toMatch(/input/);
    expect(text).toMatch(/output/);
  });

  // The user must not be asked to approve a run that would do nothing.
  it("says there is nothing to do rather than asking", async () => {
    const text = describePlan({ jobs: [], upToDate: 7, estimatedInputTokens: 0, estimatedOutputTokens: 0, skipped: [] }, "m");
    expect(text).toMatch(/All 7 traces are current/);
  });
});

describe("tracePrompt", () => {
  it("asks for intent, not for a description of the syntax", () => {
    const p = tracePrompt({ file: "src/a.ts", hash: "h", content: "code", symbols: ["alpha()"], usedBy: ["src/b.ts"], uses: [] });
    expect(p).toMatch(/what it is FOR in the product's terms/);
    expect(p).toMatch(/Used by: src\/b\.ts/);
  });

  // A trace that speculates about business purpose is worse than one that admits it does not know.
  it("forbids speculation", () => {
    const p = tracePrompt({ file: "a", hash: "h", content: "c", symbols: [], usedBy: [], uses: [] });
    expect(p).toMatch(/do NOT speculate/);
  });
});

describe("storage", () => {
  it("mirrors the source tree so a trace is findable from the path", async () => {
    await saveTrace(cwd, { file: "src/deep/a.ts", hash: "h", content: "", symbols: [], usedBy: [], uses: [] }, "BODY");
    expect(existsSync(tracePath(cwd, "src/deep/a.ts"))).toBe(true);
    expect(await readFile(tracePath(cwd, "src/deep/a.ts"), "utf8")).toContain("BODY");
  });

  it("round-trips the index", async () => {
    const index = empty();
    index.traces["a"] = { hash: "h", file: "a", writtenAt: 5 };
    await saveTraceIndex(cwd, index);
    expect((await loadTraceIndex(cwd)).traces["a"].hash).toBe("h");
  });

  it("an absent index is empty, not an error", async () => {
    expect((await loadTraceIndex(cwd)).traces).toEqual({});
  });

  it("prunes traces for files that no longer exist", async () => {
    const index = empty();
    for (const f of ["src/gone.ts", "src/kept.ts"]) {
      index.traces[f] = { hash: "h", file: f, writtenAt: 1 };
      await saveTrace(cwd, { file: f, hash: "h", content: "", symbols: [], usedBy: [], uses: [] }, "b");
    }
    const gone = await pruneTraces(cwd, new Set(["src/kept.ts"]), index);
    expect(gone).toEqual(["src/gone.ts"]);
    expect(existsSync(tracePath(cwd, "src/gone.ts"))).toBe(false);
    expect(existsSync(tracePath(cwd, "src/kept.ts"))).toBe(true);
  });

  // The path from a tool argument becomes a filesystem lookup.
  it.each(["../../../etc/passwd", "/etc/passwd", "src/../../x", ""])("refuses to read outside the trace dir: %o", (p) => {
    expect(readTraceSync(cwd, p)).toBeUndefined();
  });
});

const canned = (text: string): Provider => ({
  chat: async function* () { yield { type: "text-delta" as const, text }; },
} as unknown as Provider);

const flaky = (failOn: string): Provider => ({
  chat: async function* (req: { messages: { content: string }[] }) {
    if (req.messages.some((m) => m.content.includes(failOn))) yield { type: "error" as const, message: "boom" };
    else yield { type: "text-delta" as const, text: "OK" };
  },
} as unknown as Provider);

describe("runTraces", () => {
  it("writes a trace per file and records the hash", async () => {
    await write("src/a.ts", "export const a = 1;");
    const plan = await planTraces(cwd, ["src/a.ts"], GRAPH, empty());
    const res = await runTraces({ cwd, provider: canned("**Purpose** does a thing"), model: "m", plan, liveFiles: new Set(["src/a.ts"]) });
    expect(res.written).toBe(1);
    expect(await readFile(tracePath(cwd, "src/a.ts"), "utf8")).toContain("does a thing");
    expect((await loadTraceIndex(cwd)).traces["src/a.ts"].hash).toBe(hashContent("export const a = 1;"));
  });

  // One bad file must not cost the user the whole run they just paid for.
  it("isolates a failure and keeps the rest", async () => {
    await write("src/good.ts", "good code");
    await write("src/bad.ts", "POISON");
    const plan = await planTraces(cwd, ["src/good.ts", "src/bad.ts"], GRAPH, empty());
    const res = await runTraces({ cwd, provider: flaky("POISON"), model: "m", plan, liveFiles: new Set(["src/good.ts", "src/bad.ts"]) });
    expect(res.written).toBe(1);
    expect(res.failed.map((f) => f.file)).toEqual(["src/bad.ts"]);
    expect(existsSync(tracePath(cwd, "src/good.ts"))).toBe(true);
  });

  it("an empty response is a failure, not an empty trace", async () => {
    await write("src/a.ts", "code");
    const plan = await planTraces(cwd, ["src/a.ts"], GRAPH, empty());
    const res = await runTraces({ cwd, provider: canned("   "), model: "m", plan, liveFiles: new Set(["src/a.ts"]) });
    expect(res.written).toBe(0);
    expect(res.failed[0].error).toMatch(/empty/);
  });

  it("stops on abort without writing more", async () => {
    await write("src/a.ts", "code");
    const plan = await planTraces(cwd, ["src/a.ts"], GRAPH, empty());
    const ac = new AbortController();
    ac.abort();
    const res = await runTraces({ cwd, provider: canned("x"), model: "m", plan, liveFiles: new Set(), signal: ac.signal });
    expect(res.written).toBe(0);
    expect(res.cancelled).toBe(true);
  });

  it("reports progress per file", async () => {
    await write("src/a.ts", "code");
    await write("src/b.ts", "code2");
    const plan = await planTraces(cwd, ["src/a.ts", "src/b.ts"], GRAPH, empty());
    const seen: string[] = [];
    await runTraces({
      cwd, provider: canned("x"), model: "m", plan, liveFiles: new Set(["src/a.ts", "src/b.ts"]),
      onProgress: (ev) => seen.push(ev.file),
    });
    expect(seen.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("says where each trace went and how much was written — the report a file write gives", async () => {
    await write("src/a.ts", "code");
    const plan = await planTraces(cwd, ["src/a.ts"], GRAPH, empty());
    const events: { file: string; wroteTo?: string; words?: number; error?: string }[] = [];
    await runTraces({
      cwd, provider: canned("one two three"), model: "m", plan, liveFiles: new Set(["src/a.ts"]),
      onProgress: (ev) => events.push(ev),
    });
    expect(events[0]?.wroteTo).toBe(".horsecode/traces/src/a.ts.md");
    expect(events[0]?.words).toBe(3);
    expect(events[0]?.error).toBeUndefined();
  });

  it("reports the reason on a failure instead of going quiet", async () => {
    await write("src/a.ts", "code");
    const plan = await planTraces(cwd, ["src/a.ts"], GRAPH, empty());
    const events: { error?: string }[] = [];
    await runTraces({
      cwd, provider: canned("   "), model: "m", plan, liveFiles: new Set(["src/a.ts"]),
      onProgress: (ev) => events.push(ev),
    });
    expect(events[0]?.error).toMatch(/empty/);
  });

  /**
   * The index is the only record that a written trace exists. A run of thousands of files takes hours and
   * WILL be interrupted; saving only at the end means an interruption throws away every token it spent.
   */
  it("keeps what it has written when the run is interrupted partway", async () => {
    const files: string[] = [];
    for (let i = 0; i < 30; i++) { files.push(`src/f${i}.ts`); await write(`src/f${i}.ts`, `code${i}`); }
    const plan = await planTraces(cwd, files, GRAPH, empty());
    const ac = new AbortController();
    await runTraces({
      cwd, provider: canned("x"), model: "m", plan, liveFiles: new Set(files), signal: ac.signal,
      // Killed mid-run, exactly as a Ctrl+C would: the final save never happens.
      onProgress: (ev) => { if (ev.done === 27) ac.abort(); },
    });
    const kept = await loadTraceIndex(cwd);
    expect(Object.keys(kept.traces).length).toBeGreaterThanOrEqual(25);
  });
});

describe("ensureGitignore — the repo/local split, written for the user", () => {
  it("creates a .gitignore when there is none — and negates nothing, because nothing is excluded", async () => {
    expect(await ensureGitignore(cwd)).toBe(true);
    const gi = await readFile(join(cwd, ".gitignore"), "utf8");
    expect(gi).toContain("graphify-out/manifest.json");
    // A `!path` line for something no rule excludes is noise a reader has to decode. It used to be written
    // unconditionally.
    expect(gi).not.toContain("!.horsecode/traces/");
  });

  /**
   * The traces and the graph are project knowledge, and a repository that blocks them makes every clone
   * re-buy understanding it already paid for. Measured on a real project, `graphify-out/` was ignored
   * WHOLESALE — so the graph was never shared, and horse-code said nothing about it.
   */
  /**
   * The NAMES are re-included; the graph is not.
   *
   * `graph.json` is one line of JSON — 33.7 MB on a real project — so two branches that both rebuilt it have
   * nothing for git to reconcile. Measured on PR 677: twelve files in the merge, eleven auto-merged, and the
   * graph and the labels beside it blocked the pull request outright. The graph costs CPU to rebuild and a
   * session gets its copy through INHERITED_ASSETS; the names cost an LLM pass and cannot be re-derived.
   */
  it("re-includes the community names, and leaves the graph itself local", async () => {
    await writeFile(join(cwd, ".gitignore"), "graphify-out/\n", "utf8");
    expect(await ensureGitignore(cwd)).toBe(true);
    const gi = await readFile(join(cwd, ".gitignore"), "utf8");
    expect(gi).toContain("graphify-out/*");                        // opened, so a negation can reach inside
    expect(gi).toContain("!graphify-out/.graphify_labels.json");   // …the names an LLM wrote are kept
    expect(gi).not.toContain("!graphify-out/graph.json");          // …the graph is not
    expect(gi).not.toMatch(/^graphify-out\/$/m);
  });

  it("re-includes traces the project's own rules would have excluded", async () => {
    await writeFile(join(cwd, ".gitignore"), ".horsecode/\n", "utf8");
    await ensureGitignore(cwd);
    const gi = await readFile(join(cwd, ".gitignore"), "utf8");
    expect(gi).toContain("!.horsecode/traces/");
  });

  /**
   * From a real `git status`: three untracked `.claude/worktrees/…` directories, each a full checkout of the
   * same repository. Committing one commits the repository into itself, and that directory's abandoned
   * sibling was 29 GB.
   */
  it("keeps a nested checkout out, whichever tool made it", async () => {
    await mkdir(join(cwd, ".claude", "worktrees", "some-job"), { recursive: true });
    await writeFile(join(cwd, ".gitignore"), "node_modules/\n", "utf8");
    expect(await ensureGitignore(cwd)).toBe(true);
    expect(await readFile(join(cwd, ".gitignore"), "utf8")).toContain(".claude/worktrees/");
  });

  it("says nothing about a tool the project does not use", async () => {
    await writeFile(join(cwd, ".gitignore"), "node_modules/\n", "utf8");
    await ensureGitignore(cwd);
    // No .claude/ in this project → a rule for it would be noise in a file everyone reads.
    expect(await readFile(join(cwd, ".gitignore"), "utf8")).not.toContain(".claude/worktrees/");
  });

  it("says nothing about a directory the project already excludes deliberately", async () => {
    // graphify-out/ open and its derived files already named → nothing missing, nothing to add.
    // Derived from the source list, so a file added to LOCAL_ONLY cannot silently make this pass.
    const { localOnly } = await import("../../src/engine/trace.js");
    await writeFile(join(cwd, ".gitignore"), `${localOnly().join("\n")}\n`, "utf8");
    expect(await ensureGitignore(cwd)).toBe(false);
  });

  /**
   * The subtle rule that makes the whole thing work: git will not descend into an excluded DIRECTORY, so a
   * blanket `.horsecode/` cannot be negated for a subdirectory. It has to become `.horsecode/*`.
   */
  it("relaxes a blanket .horsecode/ ignore so the traces can be re-included", async () => {
    await writeFile(join(cwd, ".gitignore"), "dist/\n.horsecode/\nnode_modules/\n", "utf8");
    await ensureGitignore(cwd);
    const gi = await readFile(join(cwd, ".gitignore"), "utf8");
    expect(gi).toContain(".horsecode/*");
    expect(gi).not.toMatch(/^\.horsecode\/$/m);
    expect(gi).toContain("dist/"); // the user's own rules survive
  });

  it("appends once and never touches the file again", async () => {
    await writeFile(join(cwd, ".gitignore"), "dist/\n", "utf8");
    expect(await ensureGitignore(cwd)).toBe(true);
    const first = await readFile(join(cwd, ".gitignore"), "utf8");
    expect(await ensureGitignore(cwd)).toBe(false);
    expect(await readFile(join(cwd, ".gitignore"), "utf8")).toBe(first);
  });

  /**
   * The community names cost an LLM a pass over every community to write, and `graph.json` does not carry
   * them — measured on a real project, none of its 6283 names appear anywhere in the graph. That puts them in
   * the same class as the traces: knowledge a fresh clone cannot rebuild for free.
   */
  it("re-includes the community names, which the graph itself does not carry", async () => {
    await writeFile(join(cwd, ".gitignore"), "graphify-out/\n", "utf8");
    await ensureGitignore(cwd);
    const gi = await readFile(join(cwd, ".gitignore"), "utf8");
    expect(gi).toContain("!graphify-out/.graphify_labels.json");
  });

  /**
   * The marker used to end the work: `if (current.includes(MARKER)) return false` ran before anything was
   * planned, so a project that had been through this ONCE never received a rule added afterwards. Measured on
   * a real project whose `.gitignore` already carried the marker — the names rule could not reach it at all.
   *
   * The plan is already idempotent by construction (`keep()` skips a negation the file has), so the marker was
   * never what made repeat calls safe. It only made them blind.
   */
  it("adds a rule the project is still missing, even though it has been here before", async () => {
    await writeFile(join(cwd, ".gitignore"),
      `graphify-out/*\n\n${GITIGNORE_MARKER}\n!graphify-out/graph.json\n`, "utf8");
    expect(await ensureGitignore(cwd)).toBe(true);
    const gi = await readFile(join(cwd, ".gitignore"), "utf8");
    expect(gi).toContain("!graphify-out/.graphify_labels.json");
    expect(gi).toContain("!graphify-out/graph.json");        // …and what was already there survives
    expect(gi.match(/^# horse-code project knowledge$/gm)?.length).toBe(1); // one marker, not two
  });

  /**
   * A rule added on a LATER visit still has to say why it is there.
   *
   * Measured while applying this to a real project: `.horsecode/worktrees/` was appended after the community
   * names, and with the heading suppressed as a duplicate it read as one of them — a nested checkout filed
   * under "the community names an LLM wrote". Repeating one sentence costs a reader far less than that.
   */
  it("gives a late-arriving rule its own reason, not the previous group's", async () => {
    const nested = "# Nested checkouts of this repository — committing one commits the repository into itself.";
    await mkdir(join(cwd, ".claude", "worktrees", "a"), { recursive: true });
    await writeFile(join(cwd, ".gitignore"), "graphify-out/*\nnode_modules/\n", "utf8");
    await ensureGitignore(cwd);

    // …and now the OTHER nested checkout appears, on a later run.
    await mkdir(join(cwd, ".horsecode", "worktrees", "b"), { recursive: true });
    expect(await ensureGitignore(cwd)).toBe(true);
    const lines = (await readFile(join(cwd, ".gitignore"), "utf8")).split("\n").map((l) => l.trim());
    const rule = lines.lastIndexOf(".horsecode/worktrees/");
    expect(rule).toBeGreaterThan(-1);
    // Whatever else lands in the block, the line explaining this rule is the comment above it.
    const heading = lines.slice(0, rule).filter((l) => l.startsWith("#")).pop();
    expect(heading).toBe(nested);
  });

  it("still stops when a project that has been here before is missing nothing", async () => {
    // Derived from the source list, so a file added to SHARED_DERIVED cannot silently make this pass.
    const { sharedDerived } = await import("../../src/engine/trace.js");
    const rules = sharedDerived().map((p) => `!${p}`).join("\n");
    await writeFile(join(cwd, ".gitignore"),
      `graphify-out/*\n\n${GITIGNORE_MARKER}\n${rules}\n`, "utf8");
    expect(await ensureGitignore(cwd)).toBe(false);
  });

  // Only a run that produced something needs the rules; a failed run must not edit the user's files.
  it("is not written when a run produced no traces", async () => {
    await write("src/a.ts", "code");
    const plan = await planTraces(cwd, ["src/a.ts"], GRAPH, empty());
    const res = await runTraces({ cwd, provider: canned("  "), model: "m", plan, liveFiles: new Set(["src/a.ts"]) });
    expect(res.wroteGitignore).toBeFalsy();
    expect(existsSync(join(cwd, ".gitignore"))).toBe(false);
  });
});

describe("the tracer is a real role, and a strong one", () => {
  it("is in the roles the tuner must assign", async () => {
    const { REQUIRED_ROLES } = await import("../../src/prompts.js");
    expect(REQUIRED_ROLES).toContain("tracer");
  });

  it("has a prompt, so resolving the role cannot fail", async () => {
    const { DEFAULT_PROMPTS } = await import("../../src/prompts.js");
    expect(DEFAULT_PROMPTS.tracer).toMatch(/never speculate/i);
  });

  /**
   * The tuner reads these profiles to choose a model, and this assertion used to check that the profile said
   * "STRONG". It did, and the tuner obeyed it, and the result was still wrong: `strong` spans 84 to 99, so
   * the tuner satisfied the instruction with the weakest member of the band while a far better model sat in
   * the same band. Wording alone cannot express "the best of these" — so the profile now asks for the most
   * capable model, and the guarantee is enforced in code and asserted as BEHAVIOUR rather than as prose.
   */
  it("asks the tuner for the most capable model, not merely a qualifying one", async () => {
    const { ROLE_PROFILES } = await import("../../src/tui/role-models.js");
    expect(ROLE_PROFILES.tracer).toMatch(/MOST capable/);
    expect(ROLE_PROFILES.tracer).toMatch(/COMMITTED FILE/);
  });

  it("gets the best available model whatever the tuner decided", async () => {
    const { tuneRoleModels } = await import("../../src/engine/role-tuner.js");
    const catalog = ["cx/gpt-5.6-terra-medium", "cc/claude-opus-4-5-20251101", "cc/claude-opus-5", "cc/claude-fable-5"];
    // A provider that answers with exactly the assignment the real tuner made — the weakest `strong` model.
    const provider = {
      chat: async function* () {
        yield { type: "text-delta", text: '```json\n{"assignments":[{"role":"tracer","models":'
          + '["cx/gpt-5.6-terra-medium","cc/claude-opus-4-5-20251101"]}]}\n```' };
      },
    } as unknown as Parameters<typeof tuneRoleModels>[0]["provider"];
    const out = await tuneRoleModels({ provider, models: catalog, roles: ["tracer"] });
    const tracer = out.chains.find((c) => c.role === "tracer");
    expect(tracer?.models[0]).toBe("cc/claude-opus-5");
  });
});

describe("traceable — what a run should even consider", () => {
  it("drops the abandoned worktree copies that made up five sixths of a real run", async () => {
    const { traceable } = await import("../../src/engine/trace.js");
    const files = [
      "src/api/orders.ts",
      ".claude/worktrees.orphaned-backup/apiserver-slo-alerts/.agents/skills/impeccable/scripts/context.mjs",
      ".claude/skills/whatever/run.mjs",
      ".git/hooks/pre-commit.py",
      "node_modules/left-pad/index.js",
      "dist/bundle.js",
      "graphify-out/cache.js",
      "tests/api/orders.test.ts",
    ];
    expect(traceable(files)).toEqual(["src/api/orders.ts", "tests/api/orders.test.ts"]);
  });

  it("keeps only source extensions — data and markup are not code to describe", async () => {
    const { traceable } = await import("../../src/engine/trace.js");
    expect(traceable(["src/a.ts", "src/b.json", "docs/c.md", "src/d.cs", "src/e.yaml"]))
      .toEqual(["src/a.ts", "src/d.cs"]);
  });

  it("applies the same path rule to documents, so a brief is never assembled from an abandoned copy", async () => {
    const { traceable } = await import("../../src/engine/trace.js");
    expect(traceable(["README.md", ".claude/worktrees.orphaned-backup/x/README.md", "docs/architecture/00-INDEX.md"],
      { code: false })).toEqual(["README.md", "docs/architecture/00-INDEX.md"]);
  });

  it("does not mistake a dotted FILE for a dotted directory", async () => {
    const { traceable } = await import("../../src/engine/trace.js");
    expect(traceable(["src/.eslintrc.js", "src/app.config.ts"])).toEqual(["src/.eslintrc.js", "src/app.config.ts"]);
  });
});

describe("traceable — generated code is not a trace subject", () => {
  it("drops the EF Core artefacts that were only being skipped for being large", async () => {
    const { traceable } = await import("../../src/engine/trace.js");
    const files = [
      "src/infra.persistence.postgre/Migrations/20260429000547_Init.Designer.cs",
      "src/infra.persistence.postgre/Migrations/BeempaDbContextModelSnapshot.cs",
      "src/api/OrderService.cs",
    ];
    expect(traceable(files)).toEqual(["src/api/OrderService.cs"]);
  });

  it("keeps the migration itself — a person named it and its Up/Down is the schema history", async () => {
    const { traceable } = await import("../../src/engine/trace.js");
    expect(traceable(["src/infra.persistence.postgre/Migrations/20260429000547_Init.cs"]))
      .toEqual(["src/infra.persistence.postgre/Migrations/20260429000547_Init.cs"]);
  });

  it("covers the other unambiguous markers", async () => {
    const { traceable } = await import("../../src/engine/trace.js");
    expect(traceable(["a.g.cs", "b.generated.ts", "types.d.ts", "svc_pb2.py", "svc_pb2_grpc.py", "svc.pb.go", "real.ts"]))
      .toEqual(["real.ts"]);
  });
});

describe("planTraces — an adopted file is already covered", () => {
  /**
   * Adoption records that one of the PROJECT's documents already describes a file, so no per-file trace is
   * written. The planner checked only for that per-file trace, so every adopted entry looked unbacked and was
   * queued — on a real project, 414 of 424, at roughly half a million tokens to re-derive what was already
   * written down.
   */
  it("does not re-trace a file a project document already covers", async () => {
    await write("src/a.ts", "code");
    await write("docs/architecture/47-orders.md", "describes src/a.ts");
    const index = empty();
    index.traces["src/a.ts"] = {
      hash: hashContent("code"), file: "src/a.ts", writtenAt: 0, doc: "docs/architecture/47-orders.md",
    };
    const plan = await planTraces(cwd, ["src/a.ts"], GRAPH, index);
    expect(plan.jobs).toEqual([]);
    expect(plan.upToDate).toBe(1);
  });

  it("queues it again once the file has changed — the drift signal is the point", async () => {
    await write("src/a.ts", "code v2");
    await write("docs/architecture/47-orders.md", "describes src/a.ts");
    const index = empty();
    index.traces["src/a.ts"] = {
      hash: hashContent("code"), file: "src/a.ts", writtenAt: 0, doc: "docs/architecture/47-orders.md",
    };
    const plan = await planTraces(cwd, ["src/a.ts"], GRAPH, index);
    expect(plan.jobs.map((j) => j.file)).toEqual(["src/a.ts"]);
  });

  it("queues it again when the document it points at is gone", async () => {
    await write("src/a.ts", "code");
    const index = empty();
    index.traces["src/a.ts"] = {
      hash: hashContent("code"), file: "src/a.ts", writtenAt: 0, doc: "docs/architecture/deleted.md",
    };
    const plan = await planTraces(cwd, ["src/a.ts"], GRAPH, index);
    expect(plan.jobs.map((j) => j.file)).toEqual(["src/a.ts"]);
  });
});

describe("readTraceSync — a trace whose file has moved on says so", () => {
  it("marks a stale trace instead of serving it as current", async () => {
    await write("src/a.ts", "original");
    await saveTrace(cwd, { file: "src/a.ts", hash: hashContent("original"), content: "original", symbols: [], usedBy: [], uses: [] }, "It parses orders.", "m");
    await saveTraceIndex(cwd, { version: 1, traces: { "src/a.ts": { hash: hashContent("original"), file: "src/a.ts", writtenAt: 1 } } });
    expect(readTraceSync(cwd, "src/a.ts")).not.toMatch(/has changed/);

    await write("src/a.ts", "rewritten by a task");
    const body = readTraceSync(cwd, "src/a.ts");
    expect(body).toMatch(/⚠️ \*\*This file has changed/);
    expect(body).toMatch(/It parses orders\./); // the note itself is still served — it is stale, not worthless
  });

  it("marks a stale ADOPTED entry too — a project document goes out of date the same way", async () => {
    await write("src/a.ts", "original");
    await write("docs/architecture/47-orders.md", "Orders live in src/a.ts.");
    await saveTraceIndex(cwd, {
      version: 1, traces: { "src/a.ts": { hash: hashContent("original"), file: "src/a.ts", writtenAt: 1, doc: "docs/architecture/47-orders.md" } },
    });
    expect(readTraceSync(cwd, "src/a.ts")).not.toMatch(/has changed/);
    await write("src/a.ts", "rewritten");
    expect(readTraceSync(cwd, "src/a.ts")).toMatch(/⚠️ \*\*This file has changed/);
  });

  it("does not claim staleness for a file it cannot read — that is pruning's job", async () => {
    await saveTrace(cwd, { file: "src/gone.ts", hash: "h", content: "x", symbols: [], usedBy: [], uses: [] }, "note", "m");
    await saveTraceIndex(cwd, { version: 1, traces: { "src/gone.ts": { hash: "h", file: "src/gone.ts", writtenAt: 1 } } });
    expect(readTraceSync(cwd, "src/gone.ts")).not.toMatch(/has changed/);
  });
});

describe("documents are never trace subjects", () => {
  /**
   * A trace explains a source file. A document already explains itself, and writing a second account of it
   * would put two descriptions of the same thing in the repository, drifting apart from the moment the
   * second one is written. Adoption is the opposite direction and is fine: a document that describes CODE
   * is recorded as covering that code, and stays the only copy.
   */
  it("never plans a trace for markdown, however it is reached", async () => {
    const { traceable } = await import("../../src/engine/trace.js");
    expect(traceable(["README.md", "docs/architecture/47-orders.md", "src/a.ts"]))
      .toEqual(["src/a.ts"]);
  });

  it("never plans a trace for a trace", async () => {
    const { traceable } = await import("../../src/engine/trace.js");
    expect(traceable(["docs/architecture/src/api/orders.cs.md"])).toEqual([]);
  });
});

/**
 * The summary's number and the plan's work are decided by ONE rule.
 *
 * They were two: `planTraces` had the "is this covered?" test inline, and the start-up line had no test at
 * all — it printed the size of the index. Two implementations of the same question drift silently and in the
 * worst direction, so `traceState` is the only place that answers it and both callers go through it.
 */
describe("coverage counts exactly what a run would do", () => {
  it("agrees with the plan, file for file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-cov-"));
    try {
      setTraceRoot("docs/traces");
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "a.ts"), "export const a = 1;\n", "utf8");
      await writeFile(join(dir, "src", "b.ts"), "export const b = 2;\n", "utf8");
      await writeFile(join(dir, "src", "c.ts"), "export const c = 3;\n", "utf8");
      const files = ["src/a.ts", "src/b.ts", "src/c.ts"];

      // a: traced and current · b: traced then changed · c: never traced
      const index: TraceIndex = { version: 1, traces: {} };
      for (const f of ["src/a.ts", "src/b.ts"]) {
        const body = await readFile(join(dir, f), "utf8");
        index.traces[f] = { hash: hashContent(body), file: f, writtenAt: Date.now() };
        await mkdir(dirname(tracePath(dir, f)), { recursive: true });
        await writeFile(tracePath(dir, f), "# note\n", "utf8");
      }
      await writeFile(join(dir, "src", "b.ts"), "export const b = 22;\n", "utf8");

      const cov = await traceCoverage(dir, files, index);
      expect(cov).toEqual({ traceable: 3, current: 1, missing: 1, stale: 1 });

      // …and the plan queues exactly the two the coverage called out.
      const plan = await planTraces(dir, files, undefined, index);
      expect(plan.upToDate).toBe(cov.current);
      expect(plan.jobs.length).toBe(cov.missing + cov.stale);
      expect(plan.jobs.map((j) => j.file).sort()).toEqual(["src/b.ts", "src/c.ts"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /** A file too large to trace is not a gap — it is never work, so it must not sit in the denominator. */
  it("leaves out what a run would never queue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hc-cov2-"));
    try {
      setTraceRoot("docs/traces");
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "huge.ts"), "x".repeat(MAX_TRACE_FILE_CHARS + 1), "utf8");
      await writeFile(join(dir, "src", "blank.ts"), "   \n", "utf8");
      const cov = await traceCoverage(dir, ["src/huge.ts", "src/blank.ts"], { version: 1, traces: {} });
      expect(cov.traceable).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The estimate the user consents to has to predict the BILL.
 *
 * 4 characters per token is the rule of thumb for English prose, and it was wrong here in the expensive
 * direction: measured over 59,158 real calls across every configured model, the median is 3.13. Two reasons
 * and both belong in the number — this project's code and documents are Turkish, which tokenises worse, and
 * the gateway prepends a system prompt of its own (measured at ~2,000 tokens a call) that we never sent and
 * are billed for.
 */
describe("what a trace run is estimated to cost", () => {
  it("uses the measured ratio, not the English rule of thumb", async () => {
    setTraceRoot("docs/traces");
    await write("src/a.ts", "x".repeat(31_300));
    const plan = await planTraces(cwd, ["src/a.ts"], undefined, { version: 1, traces: {} });
    expect(plan.jobs).toHaveLength(1);
    // 31,300 chars at 3.13 = 10,000 tokens, plus the per-job overhead the estimate carries.
    expect(plan.estimatedInputTokens).toBeGreaterThan(10_000);
    // …and comfortably above what 4.0 would have claimed (7,825 + overhead), which is the whole point.
    expect(plan.estimatedInputTokens).toBeGreaterThan(31_300 / 4 + 500);
  });
});
