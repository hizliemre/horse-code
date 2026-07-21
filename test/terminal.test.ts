import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { makeAskUser, makeApprove, makeAskHuman, nodeLineReader } from "../src/terminal.js";
import type { PermissionRequest } from "../src/permission/engine.js";
import type { Card } from "../src/board/board.js";

const req: PermissionRequest = { level: "write", preview: "write foo.txt", allowKey: "foo.txt" };
const card = { title: "Do X" } as Card;
const verdict = { verdict: "fail" as const, notes: ["n"] };

describe("makeAskUser", () => {
  it("forwards the question to the reader, returns the answer", async () => {
    const au = makeAskUser(async (p) => { expect(p).toContain("Is it X?"); return "answer"; });
    expect(await au("Is it X?")).toBe("answer");
  });
});

describe("makeApprove", () => {
  it("y/yes → true; other → false", async () => {
    expect(await makeApprove(async () => "y")(req)).toBe(true);
    expect(await makeApprove(async () => "YES")(req)).toBe(true); // trim+lowercase
    expect(await makeApprove(async () => "h")(req)).toBe(false);
    expect(await makeApprove(async () => "yes please")(req)).toBe(false); // exact match, not a substring
    expect(await makeApprove(async () => "")(req)).toBe(false);
  });
});

describe("makeAskHuman", () => {
  it("parses accept / retry:<note> / abandon", async () => {
    expect(await makeAskHuman(async () => "accept")({ card, verdict })).toEqual({ action: "accept" });
    expect(await makeAskHuman(async () => "retry: fix it")({ card, verdict })).toEqual({ action: "retry", notes: ["fix it"] });
    expect(await makeAskHuman(async () => "retry")({ card, verdict })).toEqual({ action: "retry", notes: [] }); // no colon → empty note
    expect(await makeAskHuman(async () => "xyz")({ card, verdict })).toEqual({ action: "abandon" });
  });
});

describe("seam caret presentation (prevents a double '>' in the TUI)", () => {
  it("seam prompts do not end with a caret (the caret moved to the reader)", async () => {
    let captured = "";
    const cap = async (p: string) => { captured = p; return "x"; };
    await makeAskUser(cap)("Question?");
    expect(captured.trimEnd().endsWith(">")).toBe(false);
    await makeApprove(cap)(req);
    expect(captured.trimEnd().endsWith(">")).toBe(false);
    await makeAskHuman(cap)({ card, verdict });
    expect(captured.trimEnd().endsWith(">")).toBe(false);
  });
});

describe("nodeLineReader piped-race", () => {
  it("consecutive reads don't miss lines even if all input+EOF arrive first", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const { read, close } = nodeLineReader(input, output);
    input.write("first\n");
    input.write("second\n");
    input.end();
    expect(await read("q1")).toBe("first");
    expect(await read("q2")).toBe("second");
    expect(await read("q3")).toBe(""); // empty after EOF
    close();
  });
});
