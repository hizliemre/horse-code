import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { ModelPicker } from "../../src/tui/model-picker.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clean = (f: string | undefined) => (f ?? "").replace(/\x1b\[[0-9;]*m/g, "");

describe("ModelPicker", () => {
  it("lists models and shows the current model in the header", async () => {
    const { lastFrame, unmount } = render(
      <ModelPicker models={["a/one", "b/two"]} current="a/one" loading={false} cols={80}
        onSelect={() => {}} onCancel={() => {}} />,
    );
    await sleep(20);
    const f = clean(lastFrame());
    expect(f).toContain("Select model");
    expect(f).toContain("current: a/one");
    expect(f).toContain("b/two");
    unmount();
  });

  it("filters as you type, selects the filtered match with Enter", async () => {
    let picked: string | undefined;
    const { stdin, lastFrame, unmount } = render(
      <ModelPicker models={["a/one", "a/two", "b/three"]} current="a/one" loading={false} cols={80}
        onSelect={(m) => { picked = m; }} onCancel={() => {}} />,
    );
    await sleep(20);
    stdin.write("b/");
    await sleep(20);
    expect(clean(lastFrame())).toContain("b/three");
    stdin.write("\r");
    await sleep(20);
    expect(picked).toBe("b/three");
    unmount();
  });

  it("down arrow moves selection; Enter picks the second item", async () => {
    let picked: string | undefined;
    const { stdin, unmount } = render(
      <ModelPicker models={["a/one", "a/two"]} current="a/one" loading={false} cols={80}
        onSelect={(m) => { picked = m; }} onCancel={() => {}} />,
    );
    await sleep(20);
    stdin.write("\x1b[B"); // down
    await sleep(20);
    stdin.write("\r");
    await sleep(20);
    expect(picked).toBe("a/two");
    unmount();
  });

  it("Esc cancels", async () => {
    let cancelled = false;
    const { stdin, unmount } = render(
      <ModelPicker models={["a/one"]} current="a/one" loading={false} cols={80}
        onSelect={() => {}} onCancel={() => { cancelled = true; }} />,
    );
    await sleep(20);
    stdin.write("\x1b");
    await sleep(20);
    expect(cancelled).toBe(true);
    unmount();
  });
});
