import { describe, it, expect } from "vitest";
import { stripLoneSurrogates, sanitizeForJson, truncateSafe, REPLACEMENT } from "../../src/core/surrogates.js";

/** An emoji is two UTF-16 code units; a cut between them leaves half a character. */
const EMOJI = "🚀";           // U+1F680 → 🚀
const HIGH = EMOJI[0];        // the lone high surrogate a slice leaves behind
const LOW = EMOJI[1];

/**
 * A run of 279 minutes, 303 calls and 7.1M tokens ended with
 * `[400]: The request body is not valid JSON: invalid high surrogate in string: line 1 column 79060`.
 *
 * JavaScript strings are UTF-16 and `slice` counts code units, so a truncation that lands inside a surrogate
 * pair produces a string that is valid JavaScript and is not valid text. `JSON.stringify` encodes it, the
 * server decodes it and rejects the whole request — after the work was done.
 */
describe("text that survives being sent", () => {
  it("strips a surrogate that lost its partner", () => {
    expect(stripLoneSurrogates(`ok${HIGH}`)).toBe(`ok${REPLACEMENT}`);
    expect(stripLoneSurrogates(`${LOW}ok`)).toBe(`${REPLACEMENT}ok`);
  });

  it("leaves a whole character alone", () => {
    expect(stripLoneSurrogates(`a${EMOJI}b`)).toBe(`a${EMOJI}b`);
    expect(stripLoneSurrogates("düz metin, hiç sorun yok")).toBe("düz metin, hiç sorun yok");
  });

  /** The proof that matters: what comes out can be encoded and decoded again. */
  it("makes a broken string encodable", () => {
    const broken = `payload ${HIGH} tail`;
    expect(() => JSON.parse(JSON.stringify(broken))).not.toThrow();       // JS itself is happy…
    expect(JSON.stringify(broken)).toContain("\\ud83d");                  // …and emits the lone half
    expect(JSON.stringify(stripLoneSurrogates(broken))).not.toContain("\\ud83d");
  });

  it("reaches every string in a request body, however nested", () => {
    const body = sanitizeForJson({
      model: "m",
      messages: [{ role: "user", content: `x${HIGH}` }],
      tools: [{ name: "t", parameters: { description: `y${LOW}` } }],
      stream: true,
      n: 1,
    });
    expect(JSON.stringify(body)).not.toMatch(/\\ud8[0-9a-f]{2}(?!\\udc)/i);
    expect((body as { stream: boolean }).stream).toBe(true); // non-strings pass through untouched
    expect((body as { n: number }).n).toBe(1);
  });
});

/** …and the other half: stop producing them. */
describe("truncating without splitting a character", () => {
  it("backs off rather than cutting a pair in half", () => {
    const text = `abc${EMOJI}def`;          // length 8: a b c HIGH LOW d e f
    expect(text.slice(0, 4).endsWith(HIGH)).toBe(true);   // …what the old cut produced
    expect(truncateSafe(text, 4)).toBe("abc");            // …one character shorter, and whole
  });

  it("keeps the pair when the cut falls after it", () => {
    expect(truncateSafe(`abc${EMOJI}def`, 5)).toBe(`abc${EMOJI}`);
  });

  it("does nothing when there is nothing to cut", () => {
    expect(truncateSafe("short", 99)).toBe("short");
    expect(truncateSafe("short", 0)).toBe("short");
  });
});

/** The guard sits at the socket, where no prompt-building path can miss it. */
describe("where the guard is applied", () => {
  it("is on the body the provider sends", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/providers/omniroute.ts", "utf8");
    expect(src).toContain("JSON.stringify(sanitizeForJson(toOpenAIBody(req)))");
  });

  /** …and the truncations that feed it no longer cut by code unit. */
  it("is on the truncations that produce model input", async () => {
    const { readFile } = await import("node:fs/promises");
    expect(await readFile("src/agent/tool-exec.ts", "utf8")).toContain("truncateSafe(content, MAX_TOOL_RESULT_CHARS)");
    expect(await readFile("src/tools/git.ts", "utf8")).toContain("truncateSafe(out.text, MAX_GIT_OUTPUT)");
  });
});
