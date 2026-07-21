import type { SpecKitTemplates } from "../../src/speckit/templates.js";

/** Deterministic in-memory SpecKitTemplates stand-in for tests that don't exercise spec-kit content itself. */
export const fakeSpecKitTemplates: SpecKitTemplates = {
  version: "test",
  template: (name) => `TEMPLATE:${name}`,
  command: (name) => `COMMAND:${name}`,
};

/**
 * The loader form of the fixture: `deps.specKit` is now a `() => Promise<SpecKitTemplates>`, so every
 * fixture that writes `specKit: fakeSpecKit` stays valid unchanged.
 */
export const fakeSpecKit: () => Promise<SpecKitTemplates> = () => Promise.resolve(fakeSpecKitTemplates);
