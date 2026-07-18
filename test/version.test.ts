import { describe, it, expect } from "vitest";
import { VERSION } from "../src/version.js";

describe("VERSION", () => {
  it("semver formatında bir string döner", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
