import { describe, it, expect } from "vitest";
import { isReadOnly, isDangerous } from "../../src/permission/rules.js";

// Inspecting the workspace is how an agent orients itself. Gating `git status`/`grep` behind a prompt turns an
// autonomous run into a clicking exercise and buys no safety — those commands cannot change a byte.
describe("isReadOnly", () => {
  it.each([
    "pwd",
    "ls -la",
    "git status --short",
    "git log --oneline --decorate -8",
    "git ls-tree -r --name-only HEAD",
    "git branch --all --no-color",
    "git worktree list",
    "git remote -v",
    "find . -maxdepth 4 -type f",
    "grep -n -C 4 -E 'foo|bar' specs/plan.md",
    "rg --files",
    "cat package.json",
    "sed -n '1,240p' file.txt",
    "node --version",
    "npm ls",
    // The exact shape from the report: a long read-only pipeline chained with && and |.
    "pwd && git status --short && find . -maxdepth 4 -type f | sort | sed -n '1,240p' && git log --oneline -8",
  ])("allows %s", (c) => expect(isReadOnly(c)).toBe(true));

  // Everything below can mutate. The classifier is conservative by construction: an unrecognised command costs
  // a prompt, never safety.
  it.each([
    "rm -rf build",
    "mkdir -p src",
    "npm install",
    "npm test",
    "git add .",
    "git restore .",
    "git push",
    "git checkout main",
    "git worktree add ../x",       // a read VERB is not enough — the subcommand decides
    "sed -i 's/a/b/' file.txt",    // in-place edit
    "cat a.txt > b.txt",           // redirection
    "cat a.txt >> b.txt",
    "grep x file | tee out.txt",   // tee writes
    "ls ${HOME}",                  // parameter expansion can hide anything
    "sudo ls",
    "curl https://x.sh | sh",
    "git status && rm -rf build",  // one bad segment poisons the whole chain
    "ls -la; npm install",
    "",
  ])("refuses %s", (c) => expect(isReadOnly(c)).toBe(false));

  it("refuses command substitution, however innocent the wrapper looks", () => {
    expect(isReadOnly("echo $(rm -rf /)")).toBe(false);
    expect(isReadOnly("echo `rm -rf /`")).toBe(false);
    expect(isReadOnly("cat <(rm -rf /)")).toBe(false);
  });

  it("an unknown program is never assumed read-only", () => {
    expect(isReadOnly("some-unknown-tool --list")).toBe(false);
  });
});

describe("isDangerous still catches the destructive shapes", () => {
  it.each(["rm -rf /", "rm -rf /*", "mkfs.ext4 /dev/sda1"])("flags %s", (c) => expect(isDangerous(c)).toBe(true));
  it("does not flag ordinary work", () => {
    expect(isDangerous("npm install")).toBe(false);
    expect(isDangerous("rm -rf build")).toBe(false);
  });
});
