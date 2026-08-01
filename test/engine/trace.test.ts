import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planTraces, tracePrompt, saveTrace, pruneTraces, loadTraceIndex, saveTraceIndex,
  readTraceSync, tracePath, hashContent, MAX_TRACE_FILE_CHARS, ensureGitignore,
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
      onProgress: (_d, _t, f) => seen.push(f),
    });
    expect(seen.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("ensureGitignore — the repo/local split, written for the user", () => {
  it("creates a .gitignore when there is none", async () => {
    expect(await ensureGitignore(cwd)).toBe(true);
    const gi = await readFile(join(cwd, ".gitignore"), "utf8");
    expect(gi).toContain("!.horsecode/traces/");
    expect(gi).toContain("graphify-out/manifest.json");
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
