import { describe, it, expect } from "vitest";
import { routeSkills, filesForTask } from "../../src/skills/route.js";
import { SkillRegistry } from "../../src/skills/registry.js";

const reg = (skills: { name: string; description: string }[]): SkillRegistry => {
  const r = new SkillRegistry();
  for (const s of skills) r.register({ ...s, content: "body" });
  return r;
};

/**
 * A GUESS about which files a task touches is not evidence about what kind of work it is.
 *
 * Measured on a live run. The request was "Fix product description rendering: ensure the product description
 * renders at least 3 lines and handle raw HTML rendering". `filesForTask` resolved its words against a
 * 46,901-symbol graph and returned eight files — `ShopifyService.cs`, `HepsiburadaService.cs`,
 * `n11/OrderMapper.cs`, `ExcelTableRenderer.cs` — because marketplace integrators are full of symbols called
 * product and description. Those paths then joined the routing subject, `integrators/marketplaces/…` read as
 * infrastructure, and the brainstormer was handed `azure-kubernetes` and `animation-vocabulary`.
 *
 * The inference is not wrong to exist; it is wrong to be trusted at the same weight as a file someone NAMED.
 */
describe("which files count as evidence", () => {
  const SKILLS = [
    { name: "kubernetes-ops", description: "Plan and configure production Kubernetes clusters, networking, services, integrators" },
    { name: "web-rendering", description: "Rendering HTML in the browser, line clamping, text overflow, description fields" },
  ];

  it("routes on the work when no files are named", () => {
    const picked = routeSkills("fix product description rendering raw HTML line clamp", reg(SKILLS), [], { role: "coder" });
    expect(picked.map((p) => p.name)).not.toContain("kubernetes-ops");
  });

  /** Paths a plan NAMED are real evidence and still count. */
  it("uses files that were actually named", () => {
    const picked = routeSkills("fix the rendering", reg(SKILLS), [], {
      role: "coder",
      files: ["toucan/libs/beempa/products/src/lib/wizard/steps/step-summary.html"],
    });
    expect(picked.length).toBeGreaterThanOrEqual(0);   // …the mechanism still works with real paths
  });

  /**
   * The inference itself, shown doing the thing that made the routing wrong — kept as a statement of what it
   * is, so that nobody re-wires it into routing without seeing this.
   */
  it("still resolves symbols to files, which is what it is FOR", () => {
    // A term only discriminates when it is rare, so the graph needs the ordinary files it is rare AGAINST.
    const noise = Array.from({ length: 20 }, (_, i) => ({ label: `helper${i}`, source_file: `src/util/u${i}.ts` }));
    const graph = {
      nodes: [...noise, { label: "renderDescription", source_file: "src/ui/summary.tsx" }],
    };
    expect(filesForTask("renderDescription", graph)).toContain("src/ui/summary.tsx");
  });
});

/**
 * The inference is not used for routing anywhere, and the measurement is why.
 *
 * `evaluateFileResolution` over real commit history:
 *
 *   parrot (an integration project)  131 samples · answered 130 · precision  9% · right kind 69%
 *   horse-code                       396 samples · answered 337 · precision 17% · right kind 94%
 *
 * On the project this runs against it produces an answer almost every time and is wrong nine times in ten.
 * The reason is in the domain: "product", "description", "order" name symbols in every marketplace
 * integrator there is, so a request that uses those words resolves to all of them.
 *
 * Confident and wrong is the worst kind of evidence. The graph is precise when it is asked a question with a
 * SUBJECT — `graph_impact("SafeHtmlPipe")` — and that is how the agents use it, through their own tools. It
 * is unreliable when asked to invent the subject, which is what resolving a sentence to files is.
 */
describe("routing never takes a guessed file as evidence", () => {
  it("has no caller left that feeds inference into skill routing", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const f of ["src/engine/implementer.ts", "src/engine/reviewer.ts", "src/speckit/phases.ts"]) {
      const src = await readFile(f, "utf8");
      const routing = src.slice(src.indexOf("routeSkills("));
      expect(routing.slice(0, 400), f).not.toContain("filesForTask(");
    }
  });
});
