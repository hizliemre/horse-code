import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
    /**
     * The suite carries its own environment instead of asking every caller to remember one.
     *
     * A test asserts the bold ANSI escape a rendered question emits. Chalk — inside Ink — decides whether to
     * emit escapes from the environment, so without a TTY it switches itself off and the assertion fails on
     * a difference in the terminal rather than in the code. CI set FORCE_COLOR on its own test step and was
     * green; `npm publish` then ran the same suite through `prepublishOnly`, in an environment that step
     * could not reach, and the release failed on that one assertion after everything else had passed.
     *
     * Setting it here is the fix rather than adding the variable to a second caller: there is no third
     * caller to forget it, and a developer running `npx vitest` gets what CI gets.
     */
    env: { FORCE_COLOR: "1" },
  },
});
