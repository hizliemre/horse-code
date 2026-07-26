import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectDocs, gatherBriefInput, briefPrompt, saveBrief, loadBriefMeta, readBriefSync, briefForPrompt,
  MAX_DOC_CHARS, MAX_BRIEF_IN_PROMPT,
} from "../../src/engine/project-brief.js";
import { buildBrief } from "../../src/engine/trace-run.js";
import { tracePrompt } from "../../src/engine/trace.js";
import type { Provider } from "../../src/core/types.js";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "hc-brief-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

const write = async (file: string, body: string): Promise<void> => {
  await mkdir(join(cwd, file, ".."), { recursive: true });
  await writeFile(join(cwd, file), body, "utf8");
};

describe("selectDocs — documents that describe the product, not implement it", () => {
  it("takes the README first", () => {
    expect(selectDocs(["src/a.ts", "docs/x.md", "README.md"])[0]).toBe("README.md");
  });

  it("takes docs and specs", () => {
    const got = selectDocs(["README.md", "docs/domain.md", "specs/001-x/spec.md", "src/a.ts"]);
    expect(got).toContain("docs/domain.md");
    expect(got).toContain("specs/001-x/spec.md");
  });

  it("ignores source files", () => {
    expect(selectDocs(["src/a.ts", "src/b.py"])).toEqual([]);
  });

  // A vendored README describes someone else's product.
  it.each(["node_modules/lib/README.md", "dist/docs/x.md", "vendor/p/README.md", "CHANGELOG.md"])(
    "ignores %o", (f) => { expect(selectDocs([f])).toEqual([]); },
  );

  it("does not list the same file twice when two patterns match it", () => {
    const got = selectDocs(["docs/design.md"]);
    expect(got).toEqual([...new Set(got)]);
  });
});

describe("gatherBriefInput", () => {
  it("reads the documents and hashes them for staleness", async () => {
    await write("README.md", "# Thing\nIt does a thing.");
    const input = (await gatherBriefInput(cwd, ["README.md"]))!;
    expect(input.sources).toHaveLength(1);
    expect(input.hash).toHaveLength(16);
  });

  it("is undefined when the project documents nothing", async () => {
    await write("src/a.ts", "code");
    expect(await gatherBriefInput(cwd, ["src/a.ts"])).toBeUndefined();
  });

  // One enormous document must not crowd out every other source.
  it("clips a huge document rather than letting it fill the budget", async () => {
    await write("README.md", "x".repeat(MAX_DOC_CHARS * 3));
    await write("docs/domain.md", "the domain");
    const input = (await gatherBriefInput(cwd, ["README.md", "docs/domain.md"]))!;
    expect(input.sources.map((s) => s.file)).toContain("docs/domain.md");
    expect(input.sources[0].text.length).toBeLessThan(MAX_DOC_CHARS + 100);
  });

  it("skips an empty document", async () => {
    await write("README.md", "   ");
    expect(await gatherBriefInput(cwd, ["README.md"])).toBeUndefined();
  });
});

describe("briefPrompt", () => {
  const input = { sources: [{ file: "README.md", text: "we sell widgets" }], hash: "h", chars: 15 };

  it("asks for the domain vocabulary and the rules, not a summary", () => {
    const p = briefPrompt(input);
    expect(p).toMatch(/Domain concepts/);
    expect(p).toMatch(/glossary, not a summary/);
    expect(p).toMatch(/Rules that matter/);
  });

  /**
   * A brief that invents users or rules is worse than a short one: every trace built on it inherits the
   * invention, and it is committed to the repo where it reads as established fact.
   */
  it("forbids inventing what the documents do not state", () => {
    const p = briefPrompt(input);
    expect(p).toMatch(/Use ONLY what these documents state/);
    expect(p).toMatch(/Omit a heading entirely/);
  });

  it("includes the document text under its filename", () => {
    expect(briefPrompt(input)).toContain("### README.md");
    expect(briefPrompt(input)).toContain("we sell widgets");
  });
});

describe("the brief reaches the tracers", () => {
  const job = { file: "src/a.ts", hash: "h", content: "code", symbols: [], usedBy: [], uses: [] };

  it("a trace prompt carries the brief when there is one", () => {
    const p = tracePrompt(job, "**What it is** we sell widgets");
    expect(p).toContain("we sell widgets");
    expect(p).toMatch(/use this vocabulary/);
  });

  it("a trace prompt without a brief is unchanged", () => {
    expect(tracePrompt(job)).not.toMatch(/vocabulary/);
  });

  // The brief is the same text in every one of a few hundred prompts; the whole of it would be paid for
  // a few hundred times.
  it("clips the brief before it goes into a prompt", async () => {
    await saveBrief(cwd, "x".repeat(MAX_BRIEF_IN_PROMPT * 3), { hash: "h", sources: [], writtenAt: 1 });
    expect(briefForPrompt(cwd)!.length).toBeLessThanOrEqual(MAX_BRIEF_IN_PROMPT + 1);
  });

  it("is undefined when no brief has been written", () => {
    expect(briefForPrompt(cwd)).toBeUndefined();
  });
});

const canned = (text: string): Provider => ({
  chat: async function* () { yield { type: "text-delta" as const, text }; },
} as unknown as Provider);

const failing = (): Provider => ({
  chat: async function* () { yield { type: "error" as const, message: "boom" }; },
} as unknown as Provider);

describe("buildBrief", () => {
  it("writes the brief and records what it was built from", async () => {
    await write("README.md", "we sell widgets");
    const r = await buildBrief({ cwd, provider: canned("**What it is** widgets"), model: "m", files: ["README.md"] });
    expect(r.ok).toBe(true);
    expect(readBriefSync(cwd)).toContain("widgets");
    expect((await loadBriefMeta(cwd))!.sources).toEqual(["README.md"]);
  });

  // Tracing without a brief still produces useful notes; failing the whole run would not.
  it("a project with no documentation is reported, not fatal", async () => {
    await write("src/a.ts", "code");
    const r = await buildBrief({ cwd, provider: canned("x"), model: "m", files: ["src/a.ts"] });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/No documentation found/);
  });

  it("a failed call is reported, not fatal", async () => {
    await write("README.md", "docs");
    const r = await buildBrief({ cwd, provider: failing(), model: "m", files: ["README.md"] });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/can still run without it/);
  });

  it("an empty response does not overwrite with nothing", async () => {
    await write("README.md", "docs");
    const r = await buildBrief({ cwd, provider: canned("  "), model: "m", files: ["README.md"] });
    expect(r.ok).toBe(false);
    expect(readBriefSync(cwd)).toBeUndefined();
  });
});
