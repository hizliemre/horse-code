import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { attachedImages, handedOver, withoutPastePaths, MAX_IMAGE_BYTES } from "../../src/agent/attach.js";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "hc-att-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

/** A 1×1 PNG — real bytes, so the mime type and the encoding are exercised rather than asserted about. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

const put = async (rel: string, body: Buffer = PNG): Promise<string> => {
  await mkdir(join(cwd, rel, ".."), { recursive: true });
  await writeFile(join(cwd, rel), body);
  return join(cwd, rel);
};

/**
 * A screenshot is evidence, and there was no way to hand one over.
 *
 * The provider already sends images and a message already carries them; what was missing was any path from
 * the person at the keyboard to the agent. `addAttachment` had been written and was called from nowhere, and
 * a terminal does not paste image bytes into stdin anyway — it pastes, at best, a file name.
 *
 * So the file name IS the mechanism: say where the screenshot is and it comes along with the sentence.
 */
describe("images named in a message come with it", () => {
  it("attaches a file the text points at", async () => {
    const p = await put("shot.png");
    const imgs = attachedImages(`here is the evidence: ${p}`, cwd);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].startsWith("data:image/png;base64,")).toBe(true);
  });

  /**
   * macOS names a screenshot "Ekran Resmi 2026-08-03 saat 14.32.10.png" — spaces and all — and that is the
   * path a person pastes. A token-per-word split would find nothing at all here.
   */
  it("handles the spaces a real screenshot's name has", async () => {
    await put("Ekran Resmi 2026-08-03 saat 14.32.10.png");
    const imgs = attachedImages(`kanıt: ${cwd}/Ekran Resmi 2026-08-03 saat 14.32.10.png`, cwd);
    expect(imgs).toHaveLength(1);
  });

  it("takes a relative path, resolved against the working directory", async () => {
    await put("docs/shot.png");
    expect(attachedImages("see ./docs/shot.png", cwd)).toHaveLength(1);
    expect(attachedImages("see docs/shot.png", cwd)).toHaveLength(1);
  });

  it("takes a quoted path", async () => {
    await put("a b.png");
    expect(attachedImages(`open "${cwd}/a b.png" please`, cwd)).toHaveLength(1);
  });

  it("attaches several, in the order they were named", async () => {
    await put("one.png");
    await put("two.jpg");
    expect(attachedImages(`before ${cwd}/one.png and after ${cwd}/two.jpg`, cwd)).toHaveLength(2);
  });
});

describe("what it will not attach", () => {
  /** The existence check is the real validator — a sentence mentioning a png is not a sentence carrying one. */
  it("ignores a path that is not there", () => {
    expect(attachedImages("the failure is in missing.png", cwd)).toEqual([]);
  });

  it("ignores a file that is not an image", async () => {
    await put("notes.md", Buffer.from("# notes"));
    expect(attachedImages(`read ${cwd}/notes.md`, cwd)).toEqual([]);
  });

  /**
   * A message is not a place to move megabytes. An oversized file is skipped rather than sent, because the
   * failure it would otherwise cause arrives as a provider error in the middle of a scenario.
   */
  it("skips a file too large to be worth sending", async () => {
    await put("huge.png", Buffer.alloc(MAX_IMAGE_BYTES + 1, 1));
    expect(attachedImages(`${cwd}/huge.png`, cwd)).toEqual([]);
  });

  it("says nothing about a message that names no file", () => {
    expect(attachedImages("scenario F3 looks right to me", cwd)).toEqual([]);
  });

  /** Same file twice in one sentence is one image, not two. */
  it("does not send the same file twice", async () => {
    const p = await put("shot.png");
    expect(attachedImages(`${p} — again: ${p}`, cwd)).toHaveLength(1);
  });

  it("never reads outside what the text actually names", async () => {
    await put("shot.png");
    // A bare directory, a URL, and a word that merely ends in an extension-like string.
    expect(attachedImages(`${cwd} https://example.com/x.png version1.0.png`, cwd)).toEqual([]);
  });
});

/**
 * The path a pasted screenshot is staged at is this program's plumbing, not a fact about the work.
 *
 * Measured: a tester wrote `**Developer evidence:** /Users/…/.horsecode/pastes/paste-3050-1.png` into a test
 * report that lives in the repository. That file is per-process and machine-local — the reader of the report
 * cannot open it, and by the time an agent reads the sentence the picture is already attached to it.
 */
describe("withoutPastePaths", () => {
  it("says who handed the picture over, instead of where we happened to put it", () => {
    const said = withoutPastePaths(
      `the error looks like this: ${homedir()}/.horsecode/pastes/paste-3050-1.png — see the red banner`);
    expect(said).not.toContain(".horsecode/pastes");
    expect(said).not.toContain("paste-3050-1.png");
    expect(said).toContain("screenshot");
    expect(said).toContain("see the red banner");   // the sentence around it survives
  });

  it("leaves a file the user keeps of their own alone — that one outlives the run", () => {
    const text = `compare with ${homedir()}/Desktop/before.png`;
    expect(withoutPastePaths(text)).toBe(text);
  });

  it("stops at the file name, not at the end of the line", () => {
    const said = withoutPastePaths(`(${homedir()}/.horsecode/pastes/paste-7-2.png), then step 4`);
    expect(said).toContain("), then step 4");
  });

  it("says nothing about text that names no paste", () => {
    expect(withoutPastePaths("scenario F3 looks right")).toBe("scenario F3 looks right");
  });
});

describe("handedOver", () => {
  it("reads the image FROM the path, and hands on a sentence without it", async () => {
    const dir = join(cwd, ".horsecode", "pastes");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "paste-1-1.png"), PNG);
    const { content, images } = handedOver(`here: ${join(dir, "paste-1-1.png")}`, cwd);
    expect(images).toHaveLength(1);                  // the picture still travels…
    expect(images![0]).toMatch(/^data:image\/png;base64,/);
    expect(content).not.toContain("paste-1-1.png");  // …and the path does not
  });

  it("carries a message with no picture through unchanged", () => {
    expect(handedOver("run scenario F3", cwd)).toEqual({ content: "run scenario F3" });
  });
});
