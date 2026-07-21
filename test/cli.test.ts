import { describe, it, expect } from "vitest";
import { parseArgs, renderResult, shouldUseTui } from "../src/cli.js";

describe("parseArgs", () => {
  it("prompt + flag'ler", () => {
    expect(parseArgs(["X ekle", "--branch", "dev", "--rounds", "2"])).toEqual({ prompt: "X ekle", fromBranch: "dev", rounds: 2 });
  });
  it("çok kelimeli prompt birleşir; kısa flag'ler", () => {
    expect(parseArgs(["merhaba", "dünya", "-b", "main", "-j", "isim"])).toEqual({ prompt: "merhaba dünya", fromBranch: "main", jobName: "isim" });
  });
  it("parseArgs --revision-rounds", () => {
    expect(parseArgs(["X", "--revision-rounds", "2"])).toEqual({ prompt: "X", revisionRounds: 2 });
  });
});

describe("renderResult", () => {
  it("chat → response", () => {
    expect(renderResult({ kind: "chat", response: "cevap" })).toBe("cevap");
  });
  it("rejected → stage'i içerir", () => {
    expect(renderResult({ kind: "rejected", stage: "spec" })).toContain("spec");
  });
  it("done → rapor + PR url", () => {
    const out = renderResult({
      kind: "done", report: "rapor",
      wave: { status: "completed", session: {} as never, pr: { url: "http://pr" }, waves: [] },
      session: {} as never,
    });
    expect(out).toContain("rapor");
    expect(out).toContain("http://pr");
  });
  it("renderResult done: revision durumunu yazar", () => {
    const out = renderResult({
      kind: "done", report: "rapor",
      wave: { status: "completed", session: {} as never, pr: { url: "http://pr" }, waves: [] },
      revision: { status: "approved", rounds: 0 },
      session: {} as never,
    });
    expect(out).toContain("revision");
  });
});

describe("cli TUI dallanması", () => {
  it("parseArgs --no-tui bayrağını okur", () => {
    expect(parseArgs(["--no-tui", "yap", "bir", "şey"]).noTui).toBe(true);
    expect(parseArgs(["yap", "bir", "şey"]).noTui).toBeUndefined();
  });

  it("shouldUseTui: TTY var ve --no-tui yok → true", () => {
    expect(shouldUseTui(true, false)).toBe(true);
  });

  it("shouldUseTui: TTY yok → false (pipe/CI)", () => {
    expect(shouldUseTui(false, false)).toBe(false);
  });

  it("shouldUseTui: --no-tui → false (TTY olsa bile)", () => {
    expect(shouldUseTui(true, true)).toBe(false);
  });
});
