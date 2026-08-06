import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * The user's standing rules reach a role in exactly one of two ways, and both are easy to miss.
 *
 * `RoleRegistry.resolve()` appends them, so any role built from it is covered. A role that builds its system
 * prompt from a literal instead — and several do — gets nothing unless it asks for `ruleSuffix()` by name.
 * Measured: `triage` (twice), `normalize-question` and the summariser had no rules at all, while the tester
 * had all twenty-five TWICE, because it called `resolve()` and then appended them again.
 *
 * `normalize-question` was the one that cost something visible: it shapes the question the user reads, and a
 * rule saying "always speak Turkish" never reached it.
 *
 * This test walks every prompt construction in the engine rather than naming the ones we happen to remember —
 * the failure mode is a NEW one being added, compiling cleanly, and silently ignoring every rule.
 */
const ROOT = "src";

/** Deliberately without rules, with the reason. Anything else must justify itself here or take them. */
const EXEMPT: Record<string, string> = {
  "src/engine/coach.ts": "the conversation summariser: it talks to nobody and decides nothing — 25 rules "
    + "would be noise in a prompt whose whole job is to compress",
};

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await sources(p));
    else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("the user's rules reach every role that needs them", () => {
  it("leaves no prompt construction without them", async () => {
    const missing: string[] = [];
    for (const f of await sources(ROOT)) {
      const src = await readFile(f, "utf8");
      /**
       * A file counts when it BUILDS a prompt and RUNS an agent with it.
       *
       * Declaring the field is not filling it in: the agent loop types it and the config schema validates
       * it, and neither ever composes one. Naming the runners is the honest test — they are what turns a
       * prompt into a call.
       */
      const runsAnAgent = /run(?:RoleAgent|ToCompletion|StructuredRole)\s*\(/.test(src);
      // …and COMPOSES the prompt itself. A file that only passes on options someone else resolved has
      // nothing to add rules to — `systemPrompt: string` is a type, `z.string()` is a schema.
      const buildsPrompt = /systemPrompt:\s*(?!string[;,\s]|z\.)/.test(src);
      if (!runsAnAgent || !buildsPrompt) continue;
      // The machinery under src/agent/ IS the runner: it receives a prompt, it never authors one.
      if (f.startsWith("src/agent/")) continue;
      // Covered when the file resolves roles (resolve() appends them) or asks for the suffix by name.
      const covered = src.includes("ruleSuffix") || /\.resolve\(/.test(src);
      if (!covered && !(f in EXEMPT)) missing.push(f);
    }
    expect(missing, `no rules reach: ${missing.join(", ")}`).toEqual([]);
  });

  it("keeps every exemption explained", () => {
    for (const [file, why] of Object.entries(EXEMPT)) {
      expect(why.length, file).toBeGreaterThan(40);
    }
  });

  /** Twice is not safer: it costs a place in every prompt and reads as "these matter more". */
  it("does not append them on top of a resolved prompt", async () => {
    const src = await readFile("src/engine/verify.ts", "utf8");
    const at = src.indexOf('resolve("tester").systemPrompt');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 200)).not.toContain("ruleSuffix");
  });

  it("gives them to the roles that decide", async () => {
    const triage = await readFile("src/engine/triage.ts", "utf8");
    expect(triage.match(/ruleSuffix/g) ?? []).toHaveLength(2);   // triage a finding, and size a request
    const q = await readFile("src/engine/normalize-question.ts", "utf8");
    expect(q).toContain("ruleSuffix");                            // …and the one that words the question
  });
});
