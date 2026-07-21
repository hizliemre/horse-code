import type { SpecKitTemplates } from "../../src/speckit/templates.js";

/** Deterministic in-memory SpecKitTemplates stand-in for tests that don't exercise spec-kit content itself. */
export const fakeSpecKit: SpecKitTemplates = {
  version: "test",
  template: (name) => `TEMPLATE:${name}`,
  command: (name) => `COMMAND:${name}`,
};
