import { describe, it, expect } from "vitest";
import { classify, chunkProse, batches, groupForReview, MAX_CHUNK_CHARS } from "../../src/migrate/extract.js";
import { extractAll } from "../../src/migrate/extract.js";
import type { Finding } from "../../src/migrate/discover.js";
import type { Provider } from "../../src/core/types.js";

const canned = (text: string): Provider => ({
  chat: async function* () { yield { type: "text-delta" as const, text }; },
} as unknown as Provider);

const failing = (): Provider => ({
  chat: async function* () { yield { type: "error" as const, message: "boom" }; },
} as unknown as Provider);

const finding = (kind: Finding["kind"], label: string, text: string): Finding =>
  ({ kind, label, text, tool: "Claude Code", path: `/x/${label}`, bytes: text.length });

describe("chunkProse", () => {
  /**
   * A real project's CLAUDE.md was 53 KB and, sent whole, took minutes and produced output the model had
   * visibly stopped reading by the end.
   */
  it("splits at headings and respects the cap", () => {
    const text = ["# A", "x".repeat(5000), "# B", "y".repeat(5000), "# C", "z".repeat(5000)].join("\n");
    const chunks = chunkProse(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS * 2);
  });

  it("keeps a small document in one piece", () => {
    expect(chunkProse("# A\nshort\n# B\nalso short")).toHaveLength(1);
  });

  /** Cutting mid-section would separate a rule from the exception that follows it. */
  it("does not split a section that is itself oversized", () => {
    const chunks = chunkProse(`# Huge\n${"x".repeat(MAX_CHUNK_CHARS + 500)}`);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("# Huge");
  });

  it("empty input yields nothing", () => {
    expect(chunkProse("   ")).toEqual([]);
  });
});

describe("batches", () => {
  it("splits a large rules file and labels the parts", () => {
    const text = ["# A", "x".repeat(9000), "# B", "y".repeat(9000)].join("\n");
    const got = batches([finding("rules", "CLAUDE.md", text)]);
    expect(got.length).toBeGreaterThan(1);
    expect(got[0].body).toContain("part 1/");
    expect(got.every((b) => b.source === "CLAUDE.md")).toBe(true);
  });

  // 218 one-fact files would otherwise be 218 calls.
  it("packs several memory files into one call", () => {
    const mem = Array.from({ length: 45 }, (_, i) => finding("memory", `memory/m${i}.md`, "a fact"));
    const got = batches(mem, 20);
    expect(got).toHaveLength(3);
    expect(got[0].source).toBe("20 remembered facts");
  });

  it("ignores kinds that are not classified as prose", () => {
    expect(batches([finding("mcp", ".mcp.json", "{}"), finding("agent", "a.md", "x")])).toEqual([]);
  });

  it("ignores a finding that was too large to read", () => {
    expect(batches([{ kind: "rules", label: "big.md", tool: "t", path: "/x", bytes: 99999 }])).toEqual([]);
  });
});

describe("classify", () => {
  const run = (text: string) => classify({ provider: canned(text), model: "m", body: "b", source: "CLAUDE.md" });

  it("reads the three dispositions", async () => {
    const got = await run('```json\n{"items":[' +
      '{"text":"Always write in English","disposition":"rule","reason":"tool-agnostic"},' +
      '{"text":"The API is .NET","disposition":"fact","reason":"project knowledge"},' +
      '{"text":"Use the Task tool","disposition":"skip","reason":"names another tool"}]}\n```');
    expect(got.map((c) => c.disposition)).toEqual(["rule", "fact", "skip"]);
    expect(got[0].source).toBe("CLAUDE.md");
  });

  /** An unknown disposition must not become a rule: a wrong rule is applied to every task forever. */
  it("treats an unrecognised disposition as skip", async () => {
    const got = await run('```json\n{"items":[{"text":"x","disposition":"maybe","reason":"r"}]}\n```');
    expect(got[0].disposition).toBe("skip");
  });

  it("drops an empty item", async () => {
    const got = await run('```json\n{"items":[{"text":"  ","disposition":"rule","reason":"r"}]}\n```');
    expect(got).toEqual([]);
  });

  /** The user cannot disagree with a skip they cannot see the reason for. */
  it("always carries a reason", async () => {
    const got = await run('```json\n{"items":[{"text":"x","disposition":"skip"}]}\n```');
    expect(got[0].reason).toBe("no reason given");
  });

  it("fails loudly when the answer cannot be read", async () => {
    await expect(run("I could not decide.")).rejects.toThrow(/could not be read/);
  });

  it("propagates a provider error", async () => {
    await expect(classify({ provider: failing(), model: "m", body: "b", source: "s" })).rejects.toThrow(/boom/);
  });

  it("tells the model to prefer skip when unsure", async () => {
    let seen = "";
    const spy = {
      chat: async function* (req: { messages: { content: string }[] }) {
        seen = req.messages.map((m) => m.content).join("\n");
        yield { type: "text-delta" as const, text: '```json\n{"items":[]}\n```' };
      },
    } as unknown as Provider;
    await classify({ provider: spy, model: "m", body: "b", source: "s" });
    expect(seen).toMatch(/Prefer skip when unsure/);
    expect(seen).toMatch(/A wrong rule is applied to every task forever/);
    expect(seen).toMatch(/REWRITE each kept item so it stands alone/);
  });
});

describe("extractAll", () => {
  /** A migration that aborts halfway leaves a partly-populated memory and no way to tell what is missing. */
  it("one failing batch does not lose the others", async () => {
    const provider = {
      chat: async function* (req: { messages: { content: string }[] }) {
        if (req.messages.some((m) => m.content.includes("POISON"))) yield { type: "error" as const, message: "bad" };
        else yield { type: "text-delta" as const, text: '```json\n{"items":[{"text":"ok","disposition":"rule","reason":"r"}]}\n```' };
      },
    } as unknown as Provider;
    const got = await extractAll({
      provider, model: "m",
      findings: [finding("rules", "good.md", "fine"), finding("rules", "bad.md", "POISON")],
    });
    expect(got.candidates).toHaveLength(1);
    expect(got.failed.map((f) => f.source)).toEqual(["bad.md"]);
  });

  it("reports progress per batch", async () => {
    const seen: number[] = [];
    await extractAll({
      provider: canned('```json\n{"items":[]}\n```'), model: "m",
      findings: [finding("rules", "a.md", "x"), finding("rules", "b.md", "y")],
      onProgress: (done) => seen.push(done),
    });
    expect(seen.sort()).toEqual([1, 2]);
  });

  it("nothing to extract is not an error", async () => {
    expect(await extractAll({ provider: canned("x"), model: "m", findings: [] }))
      .toEqual({ candidates: [], failed: [] });
  });
});

describe("groupForReview", () => {
  // 218 imports must be a few decisions, not two hundred.
  it("groups by disposition so the user decides per group", () => {
    const g = groupForReview({
      candidates: [
        { text: "a", disposition: "rule", reason: "r", source: "s" },
        { text: "b", disposition: "fact", reason: "r", source: "s" },
        { text: "c", disposition: "skip", reason: "r", source: "s" },
        { text: "d", disposition: "rule", reason: "r", source: "s" },
      ],
      failed: [],
    });
    expect(g.rules).toHaveLength(2);
    expect(g.facts).toHaveLength(1);
    expect(g.skipped).toHaveLength(1);
  });
});
