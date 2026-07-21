import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { makeAskUser, makeApprove, makeAskHuman, nodeLineReader } from "../src/terminal.js";
import type { PermissionRequest } from "../src/permission/engine.js";
import type { Card } from "../src/board/board.js";

const req: PermissionRequest = { level: "write", preview: "write foo.txt", allowKey: "foo.txt" };
const card = { title: "X yap" } as Card;
const verdict = { verdict: "fail" as const, notes: ["n"] };

describe("makeAskUser", () => {
  it("soruyu okuyucuya iletir, cevabı döner", async () => {
    const au = makeAskUser(async (p) => { expect(p).toContain("X mi?"); return "cevap"; });
    expect(await au("X mi?")).toBe("cevap");
  });
});

describe("makeApprove", () => {
  it("e/evet/y/yes → true; diğer → false", async () => {
    expect(await makeApprove(async () => "e")(req)).toBe(true);
    expect(await makeApprove(async () => "evet")(req)).toBe(true);
    expect(await makeApprove(async () => "y")(req)).toBe(true);
    expect(await makeApprove(async () => "YES")(req)).toBe(true); // trim+lowercase
    expect(await makeApprove(async () => "h")(req)).toBe(false);
    expect(await makeApprove(async () => "yes please")(req)).toBe(false); // tam eşleşme, alt-dize değil
    expect(await makeApprove(async () => "")(req)).toBe(false);
  });
});

describe("makeAskHuman", () => {
  it("accept / retry:<not> / abandon parse eder", async () => {
    expect(await makeAskHuman(async () => "accept")({ card, verdict })).toEqual({ action: "accept" });
    expect(await makeAskHuman(async () => "retry: düzelt")({ card, verdict })).toEqual({ action: "retry", notes: ["düzelt"] });
    expect(await makeAskHuman(async () => "kabul")({ card, verdict })).toEqual({ action: "accept" });
    expect(await makeAskHuman(async () => "retry")({ card, verdict })).toEqual({ action: "retry", notes: [] }); // colon yok → boş not
    expect(await makeAskHuman(async () => "xyz")({ card, verdict })).toEqual({ action: "abandon" });
  });
});

describe("seam caret sunumu (TUI çift-'>' önlenir)", () => {
  it("seam prompt'ları caret ile bitmez (caret reader'a taşındı)", async () => {
    let captured = "";
    const cap = async (p: string) => { captured = p; return "x"; };
    await makeAskUser(cap)("Soru?");
    expect(captured.trimEnd().endsWith(">")).toBe(false);
    await makeApprove(cap)(req);
    expect(captured.trimEnd().endsWith(">")).toBe(false);
    await makeAskHuman(cap)({ card, verdict });
    expect(captured.trimEnd().endsWith(">")).toBe(false);
  });
});

describe("nodeLineReader piped-race", () => {
  it("tüm input+EOF önce gelse de ardışık read'ler satırları kaçırmaz", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const { read, close } = nodeLineReader(input, output);
    input.write("birinci\n");
    input.write("ikinci\n");
    input.end();
    expect(await read("q1")).toBe("birinci");
    expect(await read("q2")).toBe("ikinci");
    expect(await read("q3")).toBe(""); // EOF sonrası boş
    close();
  });
});
