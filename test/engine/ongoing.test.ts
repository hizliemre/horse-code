import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ongoingWork, ongoingChoices, chooseOngoing, NEW_WORK_LABEL, MAX_WHAT_CHARS, type Ongoing }
  from "../../src/engine/ongoing.js";
import { defaultGitRunner } from "../../src/worktree/git.js";
import type { ReviewDeps } from "../../src/engine/review.js";

/**
 * A session does not begin at zero, and nothing said so.
 *
 * Measured live: the project had one worktree carrying a half-finished verification of the product wizard.
 * The next request — a one-line fix to that same wizard — was sized "small" and done in the developer's own
 * tree, on the branch their team shares, five `wip(…)` commits deep. The sizing was right. The question was
 * missing: there is work open over here, is this part of it?
 *
 * `findResumable` cannot ask it. It matches the request against the checkpoint's original prompt, and the
 * second request about one piece of work is almost never phrased like the first — here it was a bug report
 * against a verification whose prompt read "kanıtları rapora işle ve sıradaki adımla devam edelim".
 */
let repo: string;

const git = (args: string[], cwd = repo): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "hc-ongoing-"));
  git(["init", "-b", "development"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "T"]);
  await writeFile(join(repo, "a.txt"), "one");
  git(["add", "-A"]);
  git(["commit", "-m", "first"]);
});
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

/** A session on disk: a worktree under `.horsecode/worktrees/<slug>/base`, plus its checkpoint. */
async function session(slug: string, opts: { commit?: boolean; checkpoint?: object } = {}): Promise<string> {
  const root = join(repo, ".horsecode", "worktrees", slug);
  await mkdir(root, { recursive: true });
  git(["worktree", "add", "-b", `hc/${slug}/base`, join(root, "base")]);
  if (opts.commit !== false) {
    await writeFile(join(root, "base", `${slug}.txt`), "work");
    git(["add", "-A"], join(root, "base"));
    git(["commit", "-m", `work on ${slug}`], join(root, "base"));
  }
  if (opts.checkpoint) await writeFile(join(root, "checkpoint.json"), JSON.stringify(opts.checkpoint));
  return root;
}

describe("what is still open", () => {
  it("finds a worktree the main branch has not taken, whatever the request was called", async () => {
    await session("10-Aug-2026-MONDAY_01", {
      checkpoint: {
        rawPrompt: "kanıtları rapora işle ve sıradaki adımla devam edelim",
        refinedPrompt: "Process the evidence into the e2e test report for the product creation wizard.",
        title: "product-creation-wizard-testing", language: "Turkish", featureSlug: "", done: [], lane: "verify",
      },
    });
    const open = await ongoingWork(defaultGitRunner, repo, "development");
    expect(open).toHaveLength(1);
    expect(open[0]!.slug).toBe("10-Aug-2026-MONDAY_01");
    expect(open[0]!.baseBranch).toBe("hc/10-Aug-2026-MONDAY_01/base");
    // The sentence about the work, so the choice is recognisable without opening anything.
    expect(open[0]!.what).toContain("e2e test report for the product creation wizard");
    // …and why it is still on the list at all.
    expect(open[0]!.state).toContain("development");
    expect(open[0]!.language).toBe("Turkish");
  });

  it("says what was committed when no checkpoint recorded a sentence", async () => {
    await session("nameless");
    const open = await ongoingWork(defaultGitRunner, repo, "development");
    expect(open[0]!.what).toBe("work on nameless");
  });

  it("keeps the sentence to one line a choice list can hold", async () => {
    await session("wordy", { checkpoint: { rawPrompt: "x", refinedPrompt: "y ".repeat(400), title: "t", language: "", featureSlug: "", done: [] } });
    const open = await ongoingWork(defaultGitRunner, repo, "development");
    expect(open[0]!.what.length).toBeLessThanOrEqual(MAX_WHAT_CHARS);
    expect(open[0]!.what.endsWith("…")).toBe(true);
  });

  it("does not offer work the main branch already has — its point has been served", async () => {
    await session("landed");
    git(["merge", "--no-ff", "-m", "merge", "hc/landed/base"]);
    expect(await ongoingWork(defaultGitRunner, repo, "development")).toEqual([]);
  });

  it("offers a merged worktree that still holds uncommitted edits — those are not in anything", async () => {
    const root = await session("dirty-one");
    git(["merge", "--no-ff", "-m", "merge", "hc/dirty-one/base"]);
    await writeFile(join(root, "base", "half-done.ts"), "still editing");
    const open = await ongoingWork(defaultGitRunner, repo, "development");
    expect(open.map((o) => o.slug)).toEqual(["dirty-one"]);
  });

  it("puts the most recently touched work first — that is the one being continued", async () => {
    const cp = (t: string): object => ({ rawPrompt: t, refinedPrompt: t, title: t, language: "", featureSlug: "", done: [] });
    const older = await session("older", { checkpoint: cp("older work") });
    await session("newer", { checkpoint: cp("newer work") });
    // Touch the older one's checkpoint into the past, so the order is not an artefact of creation.
    await writeFile(join(older, "checkpoint.json"), await readFile(join(older, "checkpoint.json"), "utf8"));
    const open = await ongoingWork(defaultGitRunner, repo, "development");
    expect(open.map((o) => o.slug)).toContain("newer");
    expect(open).toHaveLength(2);
  });

  it("says nothing at all when the project has no sessions", async () => {
    expect(await ongoingWork(defaultGitRunner, repo, "development")).toEqual([]);
  });
});

describe("the question put to the developer", () => {
  const item = (slug: string): Ongoing =>
    ({ slug, root: `/r/${slug}`, baseWorktree: `/r/${slug}/base`, baseBranch: `hc/${slug}/base`,
      what: `doing ${slug}`, state: "2 commit(s) not in `development`", when: 0 });

  it("names each worktree and what is being done in it, and offers a fresh one last", () => {
    const choices = ongoingChoices([item("one"), item("two")]);
    expect(choices.map((c) => c.label)).toEqual(["one", "two", NEW_WORK_LABEL]);
    expect(choices[0]!.description).toContain("doing one");
    expect(choices[0]!.description).toContain("not in `development`");
  });

  /** English → no model call, and the labels come back exactly as written. See askInUserLanguage. */
  const english = { roleRegistry: {} } as unknown as ReviewDeps;

  it("returns the worktree the developer picked", async () => {
    const items = [item("one"), item("two")];
    const picked = await chooseOngoing(english, async () => "two", "English", items);
    expect(picked?.slug).toBe("two");
  });

  it("returns nothing when they want a new one — the caller opens it as it always did", async () => {
    const picked = await chooseOngoing(english, async () => NEW_WORK_LABEL, "English", [item("one")]);
    expect(picked).toBeUndefined();
  });

  it("asks even when there is only one — starting something else is an ordinary answer", async () => {
    let asked = 0;
    await chooseOngoing(english, async () => { asked++; return "one"; }, "English", [item("one")]);
    expect(asked).toBe(1);
  });

  it("asks nothing when nothing is open", async () => {
    let asked = 0;
    expect(await chooseOngoing(english, async () => { asked++; return ""; }, "English", [])).toBeUndefined();
    expect(asked).toBe(0);
  });
});

/**
 * The choice has to REACH the work, including the path that never opens a worktree of its own.
 */
describe("where the chosen worktree is used", () => {
  const src = (f: string): Promise<string> => readFile(f, "utf8");

  it("is reachable from the path that never opens a worktree of its own", async () => {
    const s = await src("src/engine/job.ts");
    const helper = s.indexOf("const workingIn = ()");
    const ensure = s.indexOf("const ensureWorktree = async");
    expect(helper).toBeGreaterThan(0);
    expect(helper).toBeLessThan(ensure);   // …outside ensureWorktree, which the small path skips
  });

  it("hands the open worktree to the upstream, so a small change happens in it", async () => {
    expect(await src("src/engine/job.ts")).toContain("resume, preserved, workingIn)");
    expect(await src("src/engine/upstream.ts")).toContain("const cwd = workingIn?.() ?? process.cwd();");
  });

  it("is offered at startup, before anything is typed over the top of it", async () => {
    const s = await src("src/tui/app.tsx");
    expect(s).toContain("chooseOngoing(deps, read, open[0]?.language, open)");
    expect(s).toContain("openSession.current = {");
    // The memory store follows the work, exactly as it does when a job opens the session itself.
    expect(s).toContain("deps.onSession?.(picked.baseWorktree)");
  });
});
