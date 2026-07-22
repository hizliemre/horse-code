import { describe, it, expect } from "vitest";
import { resolveIconStyle, glyphSet } from "../../src/tui/glyphs.js";

describe("resolveIconStyle", () => {
  it("defaults to unicode; honors ascii/nerd; is case-insensitive; unknown → unicode", () => {
    expect(resolveIconStyle({})).toBe("unicode");
    expect(resolveIconStyle({ HORSECODE_ICON_STYLE: "ascii" })).toBe("ascii");
    expect(resolveIconStyle({ HORSECODE_ICON_STYLE: "NERD" })).toBe("nerd");
    expect(resolveIconStyle({ HORSECODE_ICON_STYLE: "banana" })).toBe("unicode");
  });
});

describe("glyphSet", () => {
  it("ascii uses plain glyphs (no box-drawing / emoji)", () => {
    const a = glyphSet("ascii");
    expect(a).toEqual({ msgBullet: "*", userBullet: ">", listBullet: "-", gutter: "|", fence: "+-", attach: "[img]" });
  });

  it("unicode uses the rich glyphs", () => {
    const u = glyphSet("unicode");
    expect(u.msgBullet).toBe("●");
    expect(u.gutter).toBe("│");
    expect(u.attach).toBe("📎");
  });
});
