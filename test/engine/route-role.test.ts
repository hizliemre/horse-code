import { describe, it, expect } from "vitest";
import { routeByEvidence } from "../../src/engine/route-role.js";

const card = (title: string, files: string[] = []) => ({ title, files });

/**
 * The router spent one model call per task on the TITLE ALONE — the weakest description on the card.
 *
 * The files a task writes and what must be true when it is done were both sitting there unused. Same shape
 * as skill routing: settle what the evidence settles, pay only for the genuinely open calls.
 */
describe("routeByEvidence", () => {
  it("sends a stylesheet to the designer", () => {
    expect(routeByEvidence(card("restyle the header", ["src/ui/header.scss"])).role).toBe("designer");
  });

  it("sends a template to the designer", () => {
    expect(routeByEvidence(card("todo list markup", ["src/app/list.html"])).role).toBe("designer");
  });

  it("sends a task whose title names design as the work to the designer", () => {
    expect(routeByEvidence(card("polish the dashboard typography")).role).toBe("designer");
  });

  it("sends plain data work to the coder", () => {
    expect(routeByEvidence(card("add store CRUD methods", ["src/store/todo.ts"])).role).toBe("coder");
  });

  it("sends a migration to the coder", () => {
    expect(routeByEvidence(card("add the todos table", ["db/migrations/001_todos.sql"])).role).toBe("coder");
  });

  it("decides a task that names no files from its title alone", () => {
    expect(routeByEvidence(card("wire up the API client")).role).toBe("coder");
  });

  /**
   * A `.tsx` file is as often a hook or a context as it is a view — the extension does not say which, and
   * guessing here is exactly the call worth paying a model for.
   */
  it("does not decide a component file on its own", () => {
    expect(routeByEvidence(card("build the todo list", ["src/components/List.tsx"])).role).toBeUndefined();
  });

  it("does not decide when design words sit over backend files", () => {
    expect(routeByEvidence(card("style the report export", ["server/report.py"])).role).toBeUndefined();
  });

  /** A stylesheet next to a query is not a design task; the two kinds of evidence disagree. */
  it("does not decide when a task writes both presentation and backend files", () => {
    expect(routeByEvidence(card("dashboard", ["src/ui/a.css", "db/migrations/2.sql"])).role).toBeUndefined();
  });

  it("says what decided it", () => {
    expect(routeByEvidence(card("x", ["src/a.css"])).why).toContain("src/a.css");
    expect(routeByEvidence(card("fix the theme")).why).toContain("theme");
  });

  // "button" and "form" name things a coder changes as often as a designer does.
  it("does not treat every interface noun as design work", () => {
    expect(routeByEvidence(card("validate the signup form", ["src/forms/signup.ts"])).role).toBe("coder");
  });

  it("survives a file with no extension and a path with no directory", () => {
    expect(() => routeByEvidence(card("x", ["Makefile", "index.ts", ""]))).not.toThrow();
  });

  it("reads a UI directory as interface work worth asking about", () => {
    expect(routeByEvidence(card("list rendering", ["src/views/list.ts"])).role).toBeUndefined();
  });
});
