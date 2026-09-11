import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  researchDir, reportName, researchRule, commitReport, describeResearch, RESEARCH_MAX_TURNS,
} from "../../src/engine/research.js";
import { routeIntent } from "../../src/engine/refiner.js";

/**
 * A request whose whole product is a written answer — a comparison, an evaluation, a recommendation with its
 * trade-offs. Sent down the pipeline it buys a brainstorm, a spec, a plan, a board and a review council, and
 * the thing actually wanted arrives as a side effect if at all.
 */
describe("research is its own lane", () => {
  it("routes to a lane of its own, not to chat and not to the pipeline", () => {
    expect(routeIntent("research")).toBe("research");
    // The lanes it sits beside, unchanged.
    expect(routeIntent("govern")).toBe("govern");
    expect(routeIntent("verify")).toBe("verify");
    expect(routeIntent("feature")).toBe("pipeline");
    expect(routeIntent("chat")).toBe("chat");
  });

  /**
   * Turns are reading here, where verification's 300 are mostly spent waiting on a person carrying out
   * scenarios. A question unanswered in this many needed narrowing, not more budget.
   */
  it("gives a reading agent a smaller budget than an interactive one", () => {
    expect(RESEARCH_MAX_TURNS).toBeLessThan(300);
  });
});

/**
 * The guarantee that matters, and the reason it is structural.
 *
 * "Do not write code" in a prompt is a request an agent can misread under pressure. The lane hands it a
 * read-only tool set and no writer at all, so the report is its ANSWER and horse-code is what puts it on
 * disk. The prompt says so plainly too, but the prompt is not what enforces it.
 */
describe("what the report must contain", () => {
  it("asks for options, a comparison and a recommendation that could be overturned", () => {
    expect(researchRule).toMatch(/options/i);
    expect(researchRule).toMatch(/comparison table/i);
    expect(researchRule).toMatch(/recommendation/i);
    expect(researchRule).toMatch(/condition that would change it/i);
  });

  /** An unexamined assumption presented as a finding is the one failure a report cannot recover from. */
  it("requires it to say what it could not establish", () => {
    expect(researchRule).toMatch(/could not establish/i);
    expect(researchRule).toMatch(/reasoning from your own knowledge/i);
  });

  it("tells the agent it has no tool that writes", () => {
    expect(researchRule).toMatch(/no \\s*tool that writes a file|no tool that writes a file/i);
  });
});

/**
 * A project that has researched before has the documents to show for it, and they are not where horse-code
 * would put them. A second directory beside an established one splits the record, and the half nobody
 * remembers is the one that rots.
 */
describe("where the document goes", () => {
  it("joins the directory this project already uses", () => {
    expect(researchDir(["docs/research/2025-queues.md", "src/a.ts"])).toBe("docs/research");
    expect(researchDir(["docs/adr/0001-storage.md"])).toBe("docs/adr");
    expect(researchDir([".planning/WORKFORCE-INTEL-SPEC.md"])).toBe(".planning");
  });

  it("falls back to a sensible default when the project has none", () => {
    expect(researchDir(["src/a.ts", "README.md"])).toBe("docs/research");
  });

  /** The subject plus the day: what somebody scanning the directory reads, and it sorts. */
  it("names the file after the request's subject", () => {
    const at = new Date("2026-09-11T10:00:00Z");
    expect(reportName("queue-technology-choice", at)).toBe("2026-09-11-queue-technology-choice.md");
    expect(reportName("", at)).toBe("2026-09-11-research.md");
    expect(reportName("Wallet & Balance: options!", at)).toBe("2026-09-11-wallet-balance-options.md");
  });
});

/**
 * A report left uncommitted in a worktree is indistinguishable from a run that failed — the reasoning the
 * trace run needed. It commits the report ALONE: a research run changes nothing else, so a commit sweeping
 * up more would describe work it did not do.
 */
describe("committing the report", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "hc-research-"));
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "T"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "x", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });
  });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  const write = async (rel: string, body: string): Promise<void> => {
    await mkdir(join(repo, "docs/research"), { recursive: true });
    await writeFile(join(repo, rel), body, "utf8");
  };

  it("commits the document on the branch it was written on", async () => {
    await write("docs/research/r.md", "# findings");
    expect(await commitReport(repo, "docs/research/r.md", "queue-choice")).toBe(true);
    const log = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: repo, encoding: "utf8" }).trim();
    expect(log).toBe("docs(research): queue-choice");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim()).toBe("");
  });

  /** Only the report. A research run changes nothing else, so anything else in the tree is not its business. */
  it("leaves everything else in the tree alone", async () => {
    await write("docs/research/r.md", "# findings");
    await writeFile(join(repo, "unrelated.txt"), "someone else's work", "utf8");
    await commitReport(repo, "docs/research/r.md", "x");
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
    expect(status).toContain("unrelated.txt");
  });

  it("says so rather than throwing when there is nothing new to commit", async () => {
    await write("docs/research/r.md", "# findings");
    expect(await commitReport(repo, "docs/research/r.md", "x")).toBe(true);
    expect(await commitReport(repo, "docs/research/r.md", "x")).toBe(false);
  });
});

describe("what the person is told", () => {
  it("names the file and the branch it was committed on", () => {
    const out = describeResearch({ reportPath: "docs/research/r.md", written: true, committed: true }, "hc/x/base");
    expect(out).toContain("docs/research/r.md");
    expect(out).toContain("hc/x/base");
    expect(out).toMatch(/no code was changed/i);
  });

  it("distinguishes written-but-uncommitted from committed", () => {
    const out = describeResearch({ reportPath: "docs/research/r.md", written: true, committed: false }, "main");
    expect(out).toMatch(/not committed/i);
  });

  it("says plainly when nothing was produced", () => {
    expect(describeResearch({ reportPath: "x.md", written: false, committed: false }, "main"))
      .toMatch(/no document/i);
  });
});
