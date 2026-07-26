import { describe, it, expect } from "vitest";
import { parseGitLog, codeFiles, evaluateFileResolution, evaluateUiDetection } from "../../src/eval/route-eval.js";
import { parseGraph } from "../../src/engine/project-graph.js";

const GRAPH = parseGraph(JSON.stringify({
  nodes: [
    { id: "1", label: "CheckoutFlow", source_file: "src/components/CheckoutFlow.tsx" },
    { id: "2", label: "retryPayment", source_file: "src/server/retry.ts" },
  ],
  links: [],
}))!;

describe("parseGitLog", () => {
  it("splits subjects from their files", () => {
    const got = parseGitLog('___fix: a thing\nsrc/a.ts\nsrc/b.ts\n___feat: another\nsrc/c.ts\n');
    expect(got).toEqual([
      { subject: "fix: a thing", files: ["src/a.ts", "src/b.ts"] },
      { subject: "feat: another", files: ["src/c.ts"] },
    ]);
  });

  it("keeps a commit that touched nothing", () => {
    expect(parseGitLog("___chore: empty\n")).toEqual([{ subject: "chore: empty", files: [] }]);
  });

  it("empty input is not an error", () => {
    expect(parseGitLog("")).toEqual([]);
  });
});

describe("codeFiles", () => {
  it("keeps source and drops the rest", () => {
    expect(codeFiles(["src/a.ts", "README.md", "package-lock.json", "src/b.tsx"]))
      .toEqual(["src/a.ts", "src/b.tsx"]);
  });

  it("drops build output and vendored trees", () => {
    expect(codeFiles(["dist/a.js", "node_modules/x/b.ts", "vendor/c.go"])).toEqual([]);
  });
});

describe("evaluateFileResolution", () => {
  /** A documentation commit has no files to resolve to; scoring it would measure the corpus, not the code. */
  it("skips samples that touched no source", () => {
    const m = evaluateFileResolution([{ subject: "docs", files: ["README.md"] }], GRAPH);
    expect(m.samples).toBe(0);
  });

  it("scores a correct resolution", () => {
    const m = evaluateFileResolution(
      [{ subject: "fix the checkout flow", files: ["src/components/CheckoutFlow.tsx"] }], GRAPH,
    );
    expect(m.precision).toBe(1);
    expect(m.recall).toBe(1);
    expect(m.exact).toBe(1);
  });

  it("scores a wrong resolution", () => {
    const m = evaluateFileResolution(
      [{ subject: "fix the checkout flow", files: ["src/server/retry.ts"] }], GRAPH,
    );
    expect(m.precision).toBe(0);
    expect(m.exact).toBe(0);
  });

  /**
   * Routing never opens a resolved path — it reads the directory words and the extension. Naming a sibling
   * component is a miss on exact paths and a success for the decision being made.
   */
  it("credits the right KIND even when the path is wrong", () => {
    const m = evaluateFileResolution(
      [{ subject: "fix the checkout flow", files: ["src/components/Other.tsx"] }], GRAPH,
    );
    expect(m.precision).toBe(0);
    expect(m.kindPrecision).toBe(1);
  });
});

describe("evaluateUiDetection", () => {
  const samples = [
    { subject: "fix the checkout flow", files: ["src/components/CheckoutFlow.tsx"] }, // true positive
    { subject: "fix retry payment", files: ["src/server/retry.ts"] },                 // true negative
    { subject: "something unrelated", files: ["src/components/Other.tsx"] },          // false negative
  ];

  it("reports the confusion matrix", () => {
    const m = evaluateUiDetection(samples, GRAPH);
    expect(m.tp).toBe(1);
    expect(m.tn).toBe(1);
    expect(m.fn).toBe(1);
    expect(m.precision).toBe(1);
    expect(m.recall).toBe(0.5);
  });

  /**
   * Reported because a skewed corpus makes a useless classifier look good: on a repository where most work
   * is not UI, "always answer no" scores well while carrying no information.
   */
  it("reports what always answering no would score", () => {
    const m = evaluateUiDetection(samples, GRAPH);
    expect(m.baselineAccuracy).toBeCloseTo(1 / 3);
  });

  it("no samples is not a crash", () => {
    const m = evaluateUiDetection([], GRAPH);
    expect(m.precision).toBe(0);
    expect(m.accuracy).toBe(0);
  });
});
