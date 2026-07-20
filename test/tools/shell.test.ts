import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { shellTool } from "../../src/tools/shell.js";

const ctx = (signal?: AbortSignal) => ({
  cwd: tmpdir(),
  signal: signal ?? new AbortController().signal,
});

describe("shell", () => {
  it("başarılı komutun çıktısını döner (exit 0)", async () => {
    const res = await shellTool.run({ command: "echo merhaba" }, ctx());
    expect(res.isError).toBe(false);
    expect(res.content).toContain("merhaba");
  });

  it("başarısız komutta isError:true döner", async () => {
    const res = await shellTool.run({ command: "exit 3" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("3");
  });

  it("describe komutu allowKey + preview yapar", () => {
    const d = shellTool.describe!({ command: "npm test" });
    expect(d.allowKey).toBe("npm test");
    expect(d.preview).toBe("npm test");
  });

  it("önceden iptal edilmiş signal'de isError döner", async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await shellTool.run({ command: "echo x" }, ctx(ac.signal));
    expect(res.isError).toBe(true);
  });

  it("geçersiz args'ta (command eksik) hata fırlatmadan isError:true döner", async () => {
    const res = await shellTool.run({}, ctx());
    expect(res.isError).toBe(true);
  });
});
