import { describe, it, expect } from "vitest";
import { readClipboardImage } from "../../src/tui/clipboard.js";

describe("readClipboardImage", () => {
  it("returns undefined on a non-darwin platform (no capture wired)", async () => {
    expect(await readClipboardImage({ platform: "linux" })).toBeUndefined();
  });

  it("returns undefined when the clipboard has no image", async () => {
    expect(await readClipboardImage({ capture: async () => undefined })).toBeUndefined();
    expect(await readClipboardImage({ capture: async () => Buffer.alloc(0) })).toBeUndefined();
  });

  it("wraps captured PNG bytes into a base64 data URI", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    const uri = await readClipboardImage({ capture: async () => bytes });
    expect(uri).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
  });
});
