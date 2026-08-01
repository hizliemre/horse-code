import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { traceDir, tracePath, setTraceRoot, traceRootRel, ensureGitignore, TRACE_DIR } from "../../src/engine/trace.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "hc-traceroot-")); });
afterEach(async () => { setTraceRoot(TRACE_DIR); await rm(root, { recursive: true, force: true }); });

/**
 * A project that generates and maintains file-level documentation keeps it somewhere deliberate — one repo
 * has 58 subsystem traces under `docs/architecture/`, generated and kept in step with the code. Writing
 * horse-code's traces into a second root would split the same kind of knowledge across two places, and
 * traces in two places are traces nobody keeps in step.
 */
describe("the trace root follows the project", () => {
  it("defaults to the tool directory", () => {
    expect(traceRootRel()).toBe(TRACE_DIR);
    expect(tracePath(root, "src/a.ts")).toBe(join(root, ".horsecode", "traces", "src", "a.ts.md"));
  });

  it("points at the project's own documentation when configured", () => {
    setTraceRoot("docs/architecture");
    expect(traceDir(root)).toBe(join(root, "docs", "architecture"));
    // Per-file traces MIRROR the source tree, so they nest below whatever documents sit flat at the top.
    expect(tracePath(root, "src/infra/Db.cs")).toBe(join(root, "docs", "architecture", "src", "infra", "Db.cs.md"));
  });

  it("ignores an empty setting rather than writing to the repo root", () => {
    setTraceRoot("");
    expect(traceRootRel()).toBe(TRACE_DIR);
    setTraceRoot("   ");
    expect(traceRootRel()).toBe(TRACE_DIR);
  });

  it("normalises a value written with leading or trailing slashes", () => {
    setTraceRoot("./docs/architecture/");
    expect(traceRootRel()).toBe("docs/architecture");
  });

  /**
   * The gitignore rule is built on demand: a block frozen at import time would name the default root while
   * traces went somewhere else — a rule that silently protects nothing.
   */
  it("keeps the configured root out of the ignore rules", async () => {
    setTraceRoot("docs/architecture");
    await writeFile(join(root, ".gitignore"), "node_modules/\n", "utf8");
    await ensureGitignore(root);
    const gi = await readFile(join(root, ".gitignore"), "utf8");
    expect(gi).toContain("!docs/architecture/");
    expect(gi).not.toContain("!.horsecode/traces/");
  });
});
