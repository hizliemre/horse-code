import { describe, it, expect } from "vitest";
import { profileProject, factHolds, MAX_EVIDENCE } from "../../src/engine/project-scan.js";

const has = (files: string[], manifests: Record<string, string> = {}) =>
  (key: string): boolean => factHolds(profileProject(files, manifests), key);

describe("profileProject — tests", () => {
  it.each([
    ["a vitest suite", ["src/a.ts", "test/a.test.ts"]],
    ["a colocated spec", ["src/a.ts", "src/a.spec.ts"]],
    ["a __tests__ directory", ["src/__tests__/a.js"]],
    ["go table tests", ["main.go", "main_test.go"]],
    ["python tests", ["app.py", "tests/test_app.py"]],
    ["ruby specs", ["lib/a.rb", "spec/a_spec.rb"]],
    ["java tests", ["src/test/java/AppTest.java"]],
  ])("finds tests from %s", (_why, files) => {
    expect(has(files)("tests")).toBe(true);
  });

  it("a project with no tests reports none", () => {
    expect(has(["src/index.ts", "README.md", "package.json"])("tests")).toBe(false);
  });

  // The signal that matters most for the user's case: a repo that simply does not test must not be told to.
  it("does not mistake a source file named after a feature for a test", () => {
    expect(has(["src/latest.ts", "src/contest.ts", "src/protest/index.ts"])("tests")).toBe(false);
  });

  // `npm init` writes this. Treating it as evidence would mark every scaffolded project as test-driven.
  it("ignores npm's placeholder test script", () => {
    const pkg = `{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}`;
    expect(has(["src/index.js", "package.json"], { "package.json": pkg })("tests")).toBe(false);
  });

  it("counts a real test script", () => {
    expect(has(["src/index.js"], { "package.json": `{"scripts":{"test":"vitest run"}}` })("tests")).toBe(true);
  });

  // A project mid-setup has the runner before it has the first test file.
  it("counts a declared test runner", () => {
    expect(has(["src/index.ts"], { "package.json": `{"devDependencies":{"vitest":"^4.0.0"}}` })("tests")).toBe(true);
  });

  it("counts a runner config file", () => {
    expect(has(["app.py", "pytest.ini"])("tests")).toBe(true);
  });
});

describe("profileProject — ui", () => {
  it("finds a UI from component files", () => {
    expect(has(["src/App.tsx", "src/app.css"])("ui")).toBe(true);
  });

  it("finds a UI from a framework dependency", () => {
    expect(has(["src/index.ts"], { "package.json": `{"dependencies":{"react":"^19.0.0"}}` })("ui")).toBe(true);
  });

  it("a backend-only project reports no UI", () => {
    expect(has(["cmd/server/main.go", "internal/db.go", "go.mod"])("ui")).toBe(false);
  });
});

describe("profileProject — reporting", () => {
  it("ranks languages by how much of the repo they are", () => {
    const p = profileProject(["a.ts", "b.ts", "c.ts", "d.py", "e.go"]);
    expect(p.languages[0]).toBe("typescript");
    expect(p.languages).toContain("python");
  });

  it("unknown languages are reported as unknown, not guessed", () => {
    expect(profileProject(["README.md"]).summary).toContain("Languages: unknown");
  });

  // The whole point of the evidence: an assignment the user can check rather than take on faith.
  it("says WHY a fact holds", () => {
    expect(profileProject(["src/a.test.ts"]).summary).toMatch(/Has tests: yes \(src\/a\.test\.ts\)/);
  });

  it("says plainly when a fact does not hold", () => {
    expect(profileProject(["src/index.ts"]).summary).toMatch(/Has tests: NO/);
  });

  it("caps the evidence so a big repo cannot flood the prompt", () => {
    const files = Array.from({ length: 500 }, (_, i) => `test/a${i}.test.ts`);
    const fact = profileProject(files).facts.find((f) => f.key === "tests")!;
    expect(fact.evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE);
  });

  it("an empty repo is not an error", () => {
    const p = profileProject([]);
    expect(p.facts.every((f) => !f.value)).toBe(true);
  });
});
