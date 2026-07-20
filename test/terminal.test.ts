import { describe, it, expect } from "vitest";
import { makeAskUser, makeApprove, makeAskHuman } from "../src/terminal.js";
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
    expect(await makeApprove(async () => "h")(req)).toBe(false);
    expect(await makeApprove(async () => "")(req)).toBe(false);
  });
});

describe("makeAskHuman", () => {
  it("accept / retry:<not> / abandon parse eder", async () => {
    expect(await makeAskHuman(async () => "accept")({ card, verdict })).toEqual({ action: "accept" });
    expect(await makeAskHuman(async () => "retry: düzelt")({ card, verdict })).toEqual({ action: "retry", notes: ["düzelt"] });
    expect(await makeAskHuman(async () => "xyz")({ card, verdict })).toEqual({ action: "abandon" });
  });
});
