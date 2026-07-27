import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextFeatureSlug, featurePaths, constitutionPath, scaffoldFeature } from "../../src/speckit/layout.js";

let wd: string;
beforeEach(async () => { wd = await mkdtemp(join(tmpdir(), "hc-lay-")); });
afterEach(async () => { await rm(wd, { recursive: true, force: true }); });

describe("layout", () => {
  it("nextFeatureSlug starts at 001 in an empty workdir", () => {
    expect(nextFeatureSlug(wd, "add login page")).toBe("001-login-page");
  });

  it("nextFeatureSlug increments past existing NNN- dirs", async () => {
    await mkdir(join(wd, "specs", "001-foo"), { recursive: true });
    await mkdir(join(wd, "specs", "002-bar"), { recursive: true });
    expect(nextFeatureSlug(wd, "fix null crash on submit here")).toBe("003-null-crash-on-submit-here");
  });

  it("featurePaths + constitutionPath produce the spec-kit layout", () => {
    const p = featurePaths(wd, "001-x");
    expect(p.spec.endsWith("specs/001-x/spec.md")).toBe(true);
    expect(p.plan.endsWith("specs/001-x/plan.md")).toBe(true);
    expect(p.tasks.endsWith("specs/001-x/tasks.md")).toBe(true);
    expect(constitutionPath(wd).endsWith(".specify/memory/constitution.md")).toBe(true);
  });

  it("scaffoldFeature creates the feature + .specify/memory dirs", () => {
    scaffoldFeature(wd, "001-x");
    expect(existsSync(join(wd, "specs", "001-x"))).toBe(true);
    expect(existsSync(join(wd, ".specify", "memory"))).toBe(true);
  });
});
