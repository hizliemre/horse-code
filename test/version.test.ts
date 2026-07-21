import { describe, it, expect } from "vitest";
import { VERSION } from "../src/version.js";

describe("VERSION", () => {
  it("returns a string in semver format", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
