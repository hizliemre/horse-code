import { describe, it, expect } from "vitest";
import { revisionReplyBody, MAX_REPLY_CHARS } from "../../src/engine/revision.js";
import { threadIdOf, REVIEW_MARKER } from "../../src/adapters/pr.js";

/**
 * The objections were on the pull request; the answers were not.
 *
 * Measured on PR #777: five "N change(s) requested" threads, every one still Active, the newest posted fifty
 * minutes before the run ended, and nowhere any statement of what had been done about any of them. Only the
 * approving exit ever spoke — the other two returned in silence — and each round opened a fresh thread
 * without pointing back at the one it was answering.
 */

describe("revisionReplyBody", () => {
  const done = { ok: true, said: "1. Fixed: renamed the field.\n2. Disagree: the guard is required." };

  it("names the commit a reader can check", () => {
    const body = revisionReplyBody(2, done, "hc: revision 2");
    expect(body).toContain(REVIEW_MARKER);
    expect(body).toContain("round 2");
    expect(body).toContain("`hc: revision 2`");
  });

  it("carries the reviser's own account of each comment", () => {
    const body = revisionReplyBody(1, done, "hc: revision 1");
    expect(body).toContain("Fixed: renamed the field.");
    expect(body).toContain("Disagree: the guard is required.");
  });

  it("says the round was cut short, rather than reading as finished work", () => {
    const body = revisionReplyBody(1, { ok: false, said: "Fixed two of five." }, "hc: revision 1");
    expect(body).toContain("turn budget");
    expect(body).toContain("next review round");
  });

  it("still answers when the reviser wrote nothing — a silent resolve is the thing to avoid", () => {
    const body = revisionReplyBody(3, { ok: true, said: "" }, "hc: revision 3");
    expect(body).toContain("no written account");
    expect(body).toContain("`hc: revision 3`");
  });

  it("cuts a transcript down to something a thread can hold", () => {
    const body = revisionReplyBody(1, { ok: true, said: "x".repeat(MAX_REPLY_CHARS + 500) }, "c");
    expect(body.length).toBeLessThan(MAX_REPLY_CHARS + 400);
    expect(body).toContain("…");
  });
});

describe("threadIdOf", () => {
  it("reads the id of the thread that was just created", () => {
    expect(threadIdOf(JSON.stringify({ id: 6018, status: "active" }))).toBe("6018");
  });

  it("returns nothing rather than a wrong id when the response cannot be read", () => {
    expect(threadIdOf("not json")).toBeUndefined();
    expect(threadIdOf("{}")).toBeUndefined();
  });
});

describe("how the revision ends is said on the pull request", () => {
  const src = async (): Promise<string> =>
    (await import("node:fs/promises")).readFile("src/engine/revision.ts", "utf8");

  it("speaks on every exit, not only the approving one", async () => {
    const s = await src();
    // Two accept exits and two human exits — rounds exhausted, and the nothing-is-moving deadlock.
    expect(s.split("sayHowItEnded(deps, postComments, \"accepted\"").length - 1).toBe(2);
    expect(s.split("sayHowItEnded(deps, postComments, \"human\"").length - 1).toBe(2);
  });

  it("answers the round's own thread after the push, so the commit is visible", async () => {
    const s = await src();
    const push = s.indexOf("await deps.manager.push(session);");
    const reply = s.indexOf("replyAndResolve(threadId, body)");
    expect(push).toBeGreaterThan(0);
    expect(reply).toBeGreaterThan(push);
  });
});
