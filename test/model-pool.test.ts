import { describe, it, expect } from "vitest";
import { poolWithConfigured } from "../src/cli.js";

const never = async (): Promise<boolean> => false;
const always = async (): Promise<boolean> => true;

/**
 * A configured model the catalog no longer lists is asked whether it still answers.
 *
 * The pool deliberately includes ids from the user's own config, because `/api/v1/models` is not a complete
 * account of what a gateway can route — `cc/claude-opus-5` answers real requests while being absent from a
 * 236-entry catalog. Without that, `/roles adjust` silently deleted models the user had chosen.
 *
 * The gap was the other direction. Reported live: the user disabled the `antigravity` provider at the
 * gateway — its catalog went from 704 models to zero antigravity — and `/roles adjust` kept offering them,
 * because 58 roles still named them and that was read as evidence they work. Evidence expires. The comment
 * claimed a dead model would be "quarantined like any other", but the health probe only RELEASES models
 * already benched; nothing questioned one on its way in.
 */
describe("what the model pool offers", () => {
  it("drops a configured model the catalog no longer lists and that no longer answers", async () => {
    const pool = await poolWithConfigured(["cc/opus", "cx/gpt"], ["cc/opus", "antigravity/gemini"], never);
    expect(pool).toEqual(["cc/opus", "cx/gpt"]);
  });

  /** The case the inclusion exists for: absent from the catalog, and demonstrably alive. */
  it("keeps one the catalog omits but which still answers", async () => {
    const pool = await poolWithConfigured(["cx/gpt"], ["cc/claude-opus-5"], always);
    expect(pool).toEqual(["cx/gpt", "cc/claude-opus-5"]);
  });

  /** A model the catalog lists is not probed at all — the cost belongs to the exception. */
  it("never probes what the catalog already lists", async () => {
    const asked: string[] = [];
    const pool = await poolWithConfigured(["a/one", "b/two"], ["a/one", "b/two"],
      async (m) => { asked.push(m); return true; });
    expect(asked).toEqual([]);
    expect(pool).toEqual(["a/one", "b/two"]);
  });

  it("asks nothing when every configured model is in the catalog", async () => {
    let calls = 0;
    await poolWithConfigured(["a/one"], ["a/one"], async () => { calls++; return true; });
    expect(calls).toBe(0);
  });

  it("keeps the catalog's own order, with survivors appended", async () => {
    const pool = await poolWithConfigured(["a/one", "b/two"], ["z/dead", "y/alive"],
      async (m) => m === "y/alive");
    expect(pool).toEqual(["a/one", "b/two", "y/alive"]);
  });

  /** A whole disabled provider is the shape this was found on: many ids, all refusing. */
  it("removes an entire provider whose models have all stopped answering", async () => {
    const configured = ["antigravity/a", "antigravity/b", "antigravity/c", "cc/opus"];
    const pool = await poolWithConfigured(["cc/opus"], configured, async (m) => !m.startsWith("antigravity/"));
    expect(pool).toEqual(["cc/opus"]);
  });
});
