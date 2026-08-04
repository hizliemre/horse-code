import { describe, it, expect } from "vitest";
import {
  recentSubjects, prAskMessage, withTaskList, fallbackPR, prSummary, MAX_EXAMPLES,
} from "../../src/engine/pr-summary.js";
import type { GitRunner } from "../../src/worktree/git.js";
import { RoleRegistry } from "../../src/agent/roles.js";
import { SkillRegistry } from "../../src/skills/registry.js";
import { PermissionEngine } from "../../src/permission/engine.js";
import type { Provider } from "../../src/core/types.js";
import type { RoleConfig } from "../../src/config/config.js";
import type { Card } from "../../src/board/board.js";

const card = (title: string): Card => ({ title } as Card);

const gitWith = (out: Record<string, string>): GitRunner =>
  (async (args: string[]) => {
    const key = args.includes("--merges") ? "merges" : "all";
    return { stdout: out[key] ?? "", stderr: "", code: out[key] === undefined ? 1 : 0 };
  }) as GitRunner;

/**
 * The pull request is read by people, and it used to be addressed to nobody.
 *
 * Measured on PR #765: title `hc: product-description-rendering-bug` — the internal job slug — over a
 * description that was 27 internal task cards under the heading "Completed tasks:". The repository it was
 * opened against writes `feat(orders): A101/BIM siparişlerinde bayi no & şube no arayüzden düzenlenebilir`.
 */
describe("the convention the project already has", () => {
  it("reads it from the merges, without azure's prefix", async () => {
    const git = gitWith({ merges: [
      "Merged PR 763: fix(messaging): Horse heartbeat'i ac, partition orphan alarmi ekle",
      "Merged PR 762: feat(orders): A101/BIM siparişlerinde bayi no arayüzden düzenlenebilir",
      "Merged PR 759: fix(enrichment): tr-TR CultureInfo yerine TurkishText",
    ].join("\n") });
    const subjects = await recentSubjects(git, "/repo", "development");
    expect(subjects[0]).toBe("fix(messaging): Horse heartbeat'i ac, partition orphan alarmi ekle");
    expect(subjects.every((s) => !s.startsWith("Merged PR"))).toBe(true);
  });

  /** A repository without merge commits still has a convention — in its commits. */
  it("falls back to plain commits when there are too few merges", async () => {
    const git = gitWith({ merges: "Merged PR 1: feat(x): one", all: "fix(a): one\nfeat(b): two\nchore: three" });
    expect(await recentSubjects(git, "/repo", "main")).toEqual(["fix(a): one", "feat(b): two", "chore: three"]);
  });

  it("says nothing when git says nothing, rather than inventing a house style", async () => {
    expect(await recentSubjects(gitWith({}), "/repo", "main")).toEqual([]);
  });

  it("shows a sample, not the history", async () => {
    const git = gitWith({ merges: Array.from({ length: 40 }, (_, i) => `feat(x): ${i}`).join("\n") });
    expect((await recentSubjects(git, "/repo", "main")).length).toBe(MAX_EXAMPLES);
  });
});

describe("what the writer is asked for", () => {
  const ask = prAskMessage("ürün açıklaması raw html render oluyor", ["Extend SafeHtmlFallbackRecord interface"],
    ["fix(messaging): Horse heartbeat'i ac"]);

  it("hands over the project's own titles as the format to follow", () => {
    expect(ask).toContain("fix(messaging): Horse heartbeat'i ac");
    expect(ask).toMatch(/same language/i);
  });

  it("asks for the outcome, and rules out the slug that was there before", () => {
    expect(ask).toMatch(/OUTCOME/);
    expect(ask).toMatch(/not a slug/i);
  });

  it("asks for prose, and says the task list is not it", () => {
    expect(ask).toMatch(/why it/i);
    expect(ask).toMatch(/NOT a task list/);
  });

  it("still shows the tasks, because they are what was done", () => {
    expect(ask).toContain("Extend SafeHtmlFallbackRecord interface");
  });

  it("names the convention explicitly when the repository has no examples to show", () => {
    expect(prAskMessage("r", ["t"], [])).toMatch(/Conventional Commits/);
  });
});

describe("the record is kept, not published as the description", () => {
  it("demotes the task list below the prose", () => {
    const out = withTaskList("Ürün açıklaması artık güvenli HTML olarak render ediliyor.", ["a", "b"]);
    expect(out.indexOf("render ediliyor")).toBeLessThan(out.indexOf("<details>"));
    expect(out).toContain("Completed tasks (2)");
    expect(out).toContain("- a");
  });

  it("adds nothing when there are no tasks", () => {
    expect(withTaskList("just this", [])).toBe("just this");
  });
});

/** A pull request that is already pushed must open, whatever the model does. */
describe("a summary that cannot be written", () => {
  const deps = (provider: Provider) => ({
    provider,
    roleRegistry: new RoleRegistry({ operational: { models: ["m"], systemPrompt: "P-op" } } as Record<string, RoleConfig>,
      {}, new SkillRegistry()),
    permission: new PermissionEngine({ mode: "auto", allowlist: [] }),
    approve: async () => true,
    signal: new AbortController().signal,
    git: gitWith({ merges: "feat(a): one\nfeat(b): two\nfeat(c): three" }),
  });

  it("falls back to what the run used to open", async () => {
    const dead: Provider = { async *chat() { throw new Error("provider down"); } };
    const res = await prSummary(deps(dead), {
      request: "r", cards: [card("t1"), card("t2")], cwd: "/repo", base: "development", jobSlug: "my-job",
    });
    expect(res).toEqual(fallbackPR("my-job", ["t1", "t2"]));
  });

  it("uses the model's answer when there is one, with the tasks kept underneath", async () => {
    const good: Provider = {
      async *chat() {
        yield { type: "tool-call", toolCall: { id: "s", name: "submit",
          arguments: JSON.stringify({ title: "fix(products): açıklama artık güvenli HTML", body: "Kısa açıklama." }) } };
        yield { type: "done", finishReason: "tool_calls" };
      },
    };
    const res = await prSummary(deps(good), {
      request: "r", cards: [card("t1")], cwd: "/repo", base: "development", jobSlug: "my-job",
    });
    expect(res.title).toBe("fix(products): açıklama artık güvenli HTML");
    expect(res.body).toContain("Kısa açıklama.");
    expect(res.body).toContain("<details>");
  });
});
