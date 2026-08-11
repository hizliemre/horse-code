import { describe, it, expect } from "vitest";
import { everTraceable } from "../../src/engine/trace.js";
import { graphTraceTool } from "../../src/tools/graph.js";
import type { ToolContext } from "../../src/core/types.js";

/**
 * "Not yet" and "never" are different answers, and only one of them invites a retry.
 *
 * `graph_trace` gave both cases the same reply — "either it has none yet or the path differs, check it with
 * graph_find" — and for a file the tracer never visits, both halves are wrong. Measured on an Angular project,
 * where a component's markup lives in `.html`: fifteen different roles asked for the trace of the SAME
 * template, every one was told it might appear later, and every one went looking before reading the file.
 * Twenty-odd calls for an answer that could not change.
 */

const ctx = (): ToolContext => ({ cwd: process.cwd(), signal: new AbortController().signal } as ToolContext);

describe("everTraceable", () => {
  it("is true for the source the tracer actually visits", () => {
    for (const f of ["src/a.ts", "src/b.tsx", "lib/c.cs", "x/d.py", "e.go", "f.java"]) {
      expect(everTraceable(f), f).toBe(true);
    }
  });

  it("is false for markup, styles and data — the kinds no trace is ever written for", () => {
    for (const f of ["a/b.html", "a/b.scss", "a/b.css", "a/b.json", "a/b.md", "a/b.yaml"]) {
      expect(everTraceable(f), f).toBe(false);
    }
  });
});

describe("what graph_trace says about a file that can never have one", () => {
  it("says never, not 'not yet'", async () => {
    const r = await graphTraceTool.run(
      { file: "toucan/libs/beempa/products/src/lib/media/product-media-manager.html" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/there never will be/);
    expect(r.content).toMatch(/templates, stylesheets or markup/);
  });

  it("tells the caller not to go looking, since looking is what it used to cause", async () => {
    const r = await graphTraceTool.run({ file: "app/widget.scss" }, ctx());
    expect(r.content).toMatch(/Read the file directly/);
    expect(r.content).toMatch(/will not turn one up/);
    expect(r.content).not.toMatch(/has none yet/);   // the sentence that invited the retry
  });

  it("keeps the old answer for source that simply has not been traced yet", async () => {
    const r = await graphTraceTool.run({ file: "src/definitely/not/traced/yet-xyz.ts" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/has none yet/);       // …that one really might appear later
    expect(r.content).toMatch(/graph_find/);
  });
});
