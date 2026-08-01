import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptDocs, indexAdoption, describeAdoption } from "../../src/engine/trace-adopt.js";
import { setTraceRoot, TRACE_DIR, readTraceSync, saveTraceIndex, hashContent } from "../../src/engine/trace.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "hc-adopt-")); setTraceRoot("docs/architecture"); });
afterEach(async () => { setTraceRoot(TRACE_DIR); await rm(root, { recursive: true, force: true }); });

const put = async (rel: string, body: string): Promise<void> => {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), body, "utf8");
};
const DOC = `# Trace 03 — Persistence

Subsystem: \`src/infra/Db.cs\` and src/infra/Ports.cs.
Unrelated mention of src/does-not-exist.cs which this repo never had.
`;

/**
 * A repository that generates its own file-level documentation has already answered, for some of its code,
 * the question a trace asks. Measured on a real one: 58 documents citing 465 paths, 420 of which exist — and
 * every one of those is a file the graph already knows. Re-deriving them would cost a model call per file
 * and produce a second, worse account that starts drifting from the first immediately.
 */
describe("adopting the project's own documents", () => {
  const files = new Set(["src/infra/Db.cs", "src/infra/Ports.cs", "src/other/Thing.cs"]);

  it("records which files a document covers", async () => {
    await put("docs/architecture/03-persistence.md", DOC);
    const a = await adoptDocs(root, files);
    expect(a.covered).toEqual({
      "src/infra/Db.cs": "docs/architecture/03-persistence.md",
      "src/infra/Ports.cs": "docs/architecture/03-persistence.md",
    });
  });

  /** A citation the graph has never seen is a typo, a moved file, or an illustration. */
  it("ignores a citation to a file this repository does not have", async () => {
    await put("docs/architecture/03-persistence.md", DOC);
    expect(Object.keys((await adoptDocs(root, files))).includes("src/does-not-exist.cs")).toBe(false);
  });

  it("does not mistake horse-code's own per-file traces for project documents", async () => {
    await put("docs/architecture/src/infra/Db.cs.md", "Purpose — the database context. See src/other/Thing.cs");
    const a = await adoptDocs(root, files);
    expect(a.covered).toEqual({}); // that file IS a trace, not a document about other files
  });

  /** The project's own ordering (00-INDEX before 47-…) puts the most general account first. */
  it("keeps the first document to claim a file", async () => {
    await put("docs/architecture/00-INDEX.md", "Overview mentioning src/infra/Db.cs");
    await put("docs/architecture/47-detail.md", "Detail also mentioning src/infra/Db.cs");
    expect((await adoptDocs(root, files)).covered["src/infra/Db.cs"]).toBe("docs/architecture/00-INDEX.md");
  });

  it("reports documents that cite nothing, rather than silently dropping them", async () => {
    await put("docs/architecture/99-prose.md", "No file references at all.");
    const a = await adoptDocs(root, files);
    expect(a.bare).toEqual(["docs/architecture/99-prose.md"]);
    expect(describeAdoption(a, 0)).toContain("nothing to adopt");
  });
});

describe("folding an adoption into the index", () => {
  it("serves the document itself when the file is asked about", async () => {
    await put("docs/architecture/03-persistence.md", DOC);
    await put("src/infra/Db.cs", "class Db {}");
    const a = await adoptDocs(root, new Set(["src/infra/Db.cs"]));
    const { index, added } = await indexAdoption(root, { version: 1, traces: {} }, a, async () => "class Db {}");
    await saveTraceIndex(root, index);

    expect(added).toBe(1);
    expect(readTraceSync(root, "src/infra/Db.cs")).toContain("Trace 03");
  });

  /** A real trace, or an earlier adoption, is never overwritten by a later scan. */
  it("leaves an existing entry alone", async () => {
    await put("docs/architecture/03-persistence.md", DOC);
    const a = await adoptDocs(root, new Set(["src/infra/Db.cs"]));
    const existing = { version: 1 as const, traces: { "src/infra/Db.cs": { hash: hashContent("x"), file: "src/infra/Db.cs", writtenAt: 5 } } };
    const { index, added } = await indexAdoption(root, existing, a, async () => "x");
    expect(added).toBe(0);
    expect(index.traces["src/infra/Db.cs"]!.writtenAt).toBe(5);
  });

  /**
   * The file's CURRENT hash is stored, exactly as a written trace stores it: when the file changes the entry
   * goes stale and the file becomes a candidate for tracing, which is the honest signal.
   */
  it("stores the file's hash so drift is visible later", async () => {
    await put("docs/architecture/03-persistence.md", DOC);
    const a = await adoptDocs(root, new Set(["src/infra/Db.cs"]));
    const { index } = await indexAdoption(root, { version: 1, traces: {} }, a, async () => "class Db {}");
    expect(index.traces["src/infra/Db.cs"]!.hash).toBe(hashContent("class Db {}"));
  });
});
