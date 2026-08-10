import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  recordedMainBranch, saveMainBranch, detectMainBranch, mainBranchChoices, resolveMainBranch,
  MAIN_BRANCH_QUESTION, type GitRun,
} from "../../src/engine/main-branch.js";
import { initTmpRepo } from "../worktree/helpers.js";

let repo = "";
afterEach(async () => { if (repo) await rm(repo, { recursive: true, force: true }); repo = ""; });

/** A git that answers only the commands the test names, and fails everything else — like a repo without them. */
function fakeGit(answers: Record<string, string>): GitRun {
  return async (args) => {
    const key = args.join(" ");
    const out = answers[key];
    return out === undefined
      ? { code: 1, stdout: "", stderr: "not found" }
      : { code: 0, stdout: out, stderr: "" };
  };
}

describe("recordedMainBranch / saveMainBranch", () => {
  it("round-trips through the PROJECT config, not the user's global one", async () => {
    repo = await initTmpRepo();
    expect(await recordedMainBranch(repo)).toBeUndefined();
    expect(await saveMainBranch(repo, "development")).toBe(true);
    expect(await recordedMainBranch(repo)).toBe("development");
    const raw = JSON.parse(await readFile(join(repo, ".horsecode", "config.json"), "utf8")) as Record<string, unknown>;
    expect(raw.mainBranch).toBe("development");
  });

  it("keeps every other setting the project had", async () => {
    repo = await initTmpRepo();
    await mkdir(join(repo, ".horsecode"), { recursive: true });
    await writeFile(join(repo, ".horsecode", "config.json"), JSON.stringify({ traceDir: "docs/architecture" }), "utf8");
    await saveMainBranch(repo, "main");
    const raw = JSON.parse(await readFile(join(repo, ".horsecode", "config.json"), "utf8")) as Record<string, unknown>;
    expect(raw).toEqual({ traceDir: "docs/architecture", mainBranch: "main" });
  });

  it("an unreadable or non-JSON config reads as 'nothing recorded', not as an error", async () => {
    repo = await initTmpRepo();
    await mkdir(join(repo, ".horsecode"), { recursive: true });
    await writeFile(join(repo, ".horsecode", "config.json"), "{ not json", "utf8");
    expect(await recordedMainBranch(repo)).toBeUndefined();
  });
});

describe("detectMainBranch", () => {
  it("reads origin/HEAD when the remote declares one", async () => {
    const git = fakeGit({ "symbolic-ref --short refs/remotes/origin/HEAD": "origin/development\n" });
    expect(await detectMainBranch("/x", git)).toBe("development");
  });

  it("returns nothing rather than guessing when origin/HEAD is unset", async () => {
    // The case that made this whole path necessary: a real project whose origin/HEAD is not a symbolic ref.
    expect(await detectMainBranch("/x", fakeGit({}))).toBeUndefined();
  });
});

describe("mainBranchChoices", () => {
  it("puts the conventional names first and never offers a branch the remote lacks", () => {
    const choices = mainBranchChoices(["feature/x", "development", "release/1", "main"]);
    expect(choices.slice(0, 2)).toEqual(["main", "development"]);
    expect(choices).toContain("feature/x");
    expect(choices).not.toContain("master"); // conventional, but this remote does not have it
  });

  it("excludes the branch being worked on — the question is which branch work comes FROM", () => {
    expect(mainBranchChoices(["main", "feature/x"], "feature/x")).toEqual(["main"]);
  });

  it("never offers a horse-code session branch as the project's trunk", () => {
    expect(mainBranchChoices(["hc/07-Aug-2026-FRIDAY_01/base", "development"])).toEqual(["development"]);
  });

  it("caps the list so a repo with hundreds of branches does not bury the answer", () => {
    const many = Array.from({ length: 40 }, (_, i) => `feature/${i}`);
    expect(mainBranchChoices(["main", ...many]).length).toBe(8);
  });
});

describe("resolveMainBranch", () => {
  it("asks once, records the answer, and never asks again", async () => {
    repo = await initTmpRepo();
    let asked = 0;
    const askUser = async (): Promise<string> => { asked++; return "development"; };
    const git = fakeGit({}); // no origin/HEAD, no remote branches → the user is the only source

    expect(await resolveMainBranch({ cwd: repo, git, askUser })).toBe("development");
    expect(asked).toBe(1);
    expect(await resolveMainBranch({ cwd: repo, git, askUser })).toBe("development");
    expect(asked).toBe(1); // the second resume reads what the first one wrote
  });

  it("offers the remote's branches as choices", async () => {
    repo = await initTmpRepo();
    let offered: string[] | undefined;
    const askUser = async (_q: string, o?: { options?: string[] }): Promise<string> => {
      offered = o?.options;
      return "development";
    };
    const git = fakeGit({
      "for-each-ref --format=%(refname:short) refs/remotes/origin": "origin/development\norigin/feature/a\n",
    });
    await resolveMainBranch({ cwd: repo, git, askUser });
    expect(offered).toEqual(["development", "feature/a"]);
  });

  it("does not ask at all when git can prove it — and records the proof", async () => {
    repo = await initTmpRepo();
    let asked = 0;
    const git = fakeGit({ "symbolic-ref --short refs/remotes/origin/HEAD": "origin/main\n" });
    const branch = await resolveMainBranch({ cwd: repo, git, askUser: async () => { asked++; return "x"; } });
    expect(branch).toBe("main");
    expect(asked).toBe(0);
    expect(await recordedMainBranch(repo)).toBe("main");
  });

  it("asks in the language the caller phrases it in — this question has no agent to obey the rule for it", async () => {
    repo = await initTmpRepo();
    let asked = "";
    await resolveMainBranch({
      cwd: repo, git: fakeGit({}),
      askUser: async (q: string) => { asked = q; return "main"; },
      phrase: async (t) => `TR(${t.slice(0, 12)})`,
    });
    expect(asked).toBe(`TR(${MAIN_BRANCH_QUESTION.slice(0, 12)})`);
  });

  it("asks it as written when no phrasing is supplied", async () => {
    repo = await initTmpRepo();
    let asked = "";
    await resolveMainBranch({
      cwd: repo, git: fakeGit({}),
      askUser: async (q: string) => { asked = q; return "main"; },
    });
    expect(asked).toBe(MAIN_BRANCH_QUESTION);
  });

  it("an empty answer leaves nothing recorded — the question can be asked again next time", async () => {
    repo = await initTmpRepo();
    const branch = await resolveMainBranch({ cwd: repo, git: fakeGit({}), askUser: async () => "  " });
    expect(branch).toBeUndefined();
    expect(await recordedMainBranch(repo)).toBeUndefined();
  });
});
