# /model Command (Model Picker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/model` TUI command that lists omniroute's models in a filterable picker (↑/↓/Enter) and live-switches the running session's model for subsequent turns.

**Architecture:** A pure model-list fetcher (`listOmniRouteModels`) + a mutable model override on `RoleRegistry` (no deps rebuild) + a `ModelPicker` Ink modal + picker state on `TuiController` + `/model` slash-dispatch and wiring in `App`/`runTuiRepl`/`cli`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), React + Ink, Vitest + ink-testing-library, Zod (unused here), omniroute OpenAI-compatible API.

## Global Constraints

- **No Turkish anywhere in code/tests/UI strings.** All identifiers, comments, test labels, and user-facing strings are English (matches existing TUI, e.g. `src/tui/labels.ts`). The design doc is Turkish; the code is not.
- **ESM imports use `.js` specifiers** (e.g. `import { x } from "./omniroute.js"`), TypeScript source.
- **TDD:** write the failing test first, watch it fail, implement minimally, watch it pass, commit.
- **Commands:** run one test file with `npx vitest run <path>`; full suite `npm test`; types `npm run typecheck`; build `npm run build`. All must stay green.
- **Selection is session-only + live** — never write `~/.horsecode/config.json`.

---

### Task 1: `listOmniRouteModels` — fetch + parse omniroute model ids

**Files:**
- Create: `src/providers/models.ts`
- Test: `test/providers/models.test.ts`

**Interfaces:**
- Consumes: `FetchLike` from `src/providers/omniroute.ts` (`export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;`).
- Produces: `listOmniRouteModels(opts: { baseUrl: string; apiKey?: string; fetch?: FetchLike }): Promise<string[]>` — sorted, de-duplicated model ids.

- [ ] **Step 1: Write the failing test**

```ts
// test/providers/models.test.ts
import { describe, it, expect } from "vitest";
import { listOmniRouteModels } from "../../src/providers/models.js";
import type { FetchLike } from "../../src/providers/omniroute.js";

function fakeFetch(body: unknown, ok = true, status = 200): FetchLike {
  return async () => new Response(JSON.stringify(body), { status: ok ? status : status });
}

describe("listOmniRouteModels", () => {
  it("returns sorted, de-duplicated ids from data[]", async () => {
    const fetch = fakeFetch({ data: [{ id: "b/two" }, { id: "a/one" }, { id: "a/one" }] });
    const ids = await listOmniRouteModels({ baseUrl: "http://x", fetch });
    expect(ids).toEqual(["a/one", "b/two"]);
  });

  it("sends Authorization header when apiKey is given, hits /api/v1/models", async () => {
    let seenUrl = ""; let seenAuth: string | null = null;
    const fetch: FetchLike = async (url, init) => {
      seenUrl = url;
      seenAuth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
    await listOmniRouteModels({ baseUrl: "http://x/", apiKey: "k", fetch });
    expect(seenUrl).toBe("http://x/api/v1/models");
    expect(seenAuth).toBe("Bearer k");
  });

  it("throws on a non-ok response", async () => {
    const fetch: FetchLike = async () => new Response("", { status: 500 });
    await expect(listOmniRouteModels({ baseUrl: "http://x", fetch })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/providers/models.test.ts`
Expected: FAIL — cannot import `listOmniRouteModels` (module missing).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/providers/models.ts
import type { FetchLike } from "./omniroute.js";

/** Fetches omniroute's model ids from GET /api/v1/models (sorted, de-duplicated). */
export async function listOmniRouteModels(opts: {
  baseUrl: string;
  apiKey?: string;
  fetch?: FetchLike;
}): Promise<string[]> {
  const fetchFn = opts.fetch ?? (globalThis.fetch as FetchLike);
  const headers: Record<string, string> = {};
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const base = opts.baseUrl.replace(/\/$/, "");
  const res = await fetchFn(`${base}/api/v1/models`, { headers });
  if (!res.ok) throw new Error(`omniroute models ${res.status}`);
  const body = (await res.json()) as { data?: { id?: unknown }[] };
  const ids = (body.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string");
  return [...new Set(ids)].sort();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/providers/models.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/providers/models.ts test/providers/models.test.ts
git commit -m "feat(providers): listOmniRouteModels — fetch model ids from omniroute"
```

---

### Task 2: `RoleRegistry.setModelOverride` — live model swap

**Files:**
- Modify: `src/agent/roles.ts` (class `RoleRegistry`)
- Test: `test/agent/roles.test.ts` (append)

**Interfaces:**
- Produces: `RoleRegistry.setModelOverride(model?: string): void`. When set to a non-empty string, `resolve(role).model` returns it for **every** role; `undefined`/empty clears it (back to `role.models[...]`). `systemPrompt` is unaffected.

- [ ] **Step 1: Write the failing test**

```ts
// test/agent/roles.test.ts — append inside the existing top-level describe or add a new one
import { describe, it, expect } from "vitest";
import { RoleRegistry } from "../../src/agent/roles.js";

describe("RoleRegistry.setModelOverride", () => {
  it("overrides the model for every role until cleared; systemPrompt unchanged", () => {
    const reg = new RoleRegistry(
      { coder: { models: ["m1"] }, coach: { models: ["m2"] } },
      { coder: "P-coder", coach: "P-coach" },
    );
    expect(reg.resolve("coder").model).toBe("m1");

    reg.setModelOverride("live/model");
    expect(reg.resolve("coder").model).toBe("live/model");
    expect(reg.resolve("coach").model).toBe("live/model");
    expect(reg.resolve("coder").systemPrompt).toBe("P-coder");

    reg.setModelOverride(undefined);
    expect(reg.resolve("coder").model).toBe("m1");

    reg.setModelOverride("");
    expect(reg.resolve("coach").model).toBe("m2"); // empty string clears
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/agent/roles.test.ts`
Expected: FAIL — `reg.setModelOverride` is not a function.

- [ ] **Step 3: Write minimal implementation**

In `src/agent/roles.ts`, add a field + method to `RoleRegistry` and consult it in `resolve`.

Add the field right after the class opening (below `private index = new Map<string, number>();`):

```ts
  private modelOverride?: string;

  /** Live-swap the model used by every role (session-only; clears on undefined/empty). */
  setModelOverride(model?: string): void {
    this.modelOverride = model && model.length > 0 ? model : undefined;
  }
```

In `resolve`, change the model selection line. Replace:

```ts
    const i = this.index.get(roleName) ?? 0;
    const model = role.models[i % role.models.length];
    this.index.set(roleName, i + 1);
```

with:

```ts
    const i = this.index.get(roleName) ?? 0;
    const model = this.modelOverride ?? role.models[i % role.models.length];
    this.index.set(roleName, i + 1);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/agent/roles.test.ts`
Expected: PASS (new test + existing role tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/roles.ts test/agent/roles.test.ts
git commit -m "feat(roles): RoleRegistry.setModelOverride for live model swap"
```

---

### Task 3: `TuiController` picker state

**Files:**
- Modify: `src/tui/controller.ts`
- Test: `test/tui/controller.test.ts` (append)

**Interfaces:**
- Produces (on `TuiController`):
  - State fields: `mode?: "input" | "running" | "picker"`, `picker?: { models: string[]; loading: boolean; error?: string }`, `currentModel: string` (starts `""`).
  - `openPicker(): void` → `mode="picker"`, `picker={models:[],loading:true}`.
  - `setPickerModels(models: string[]): void` → `picker={models,loading:false}`.
  - `setPickerError(msg: string): void` → `picker={models:[],loading:false,error:msg}`.
  - `applyModel(model: string): void` → `currentModel=model`, `mode="input"`, `picker=undefined`.
  - `cancelPicker(): void` → `mode="input"`, `picker=undefined`.

- [ ] **Step 1: Write the failing test**

```ts
// test/tui/controller.test.ts — append inside the existing describe("TuiController", ...)
  it("picker: openPicker → setPickerModels → applyModel flow", () => {
    const c = new TuiController();
    c.openPicker();
    expect(c.getState().mode).toBe("picker");
    expect(c.getState().picker).toEqual({ models: [], loading: true });

    c.setPickerModels(["a/one", "b/two"]);
    expect(c.getState().picker).toEqual({ models: ["a/one", "b/two"], loading: false });

    c.applyModel("a/one");
    expect(c.getState().mode).toBe("input");
    expect(c.getState().picker).toBeUndefined();
    expect(c.getState().currentModel).toBe("a/one");
  });

  it("picker: setPickerError + cancelPicker", () => {
    const c = new TuiController();
    c.openPicker();
    c.setPickerError("network down");
    expect(c.getState().picker).toEqual({ models: [], loading: false, error: "network down" });
    c.cancelPicker();
    expect(c.getState().mode).toBe("input");
    expect(c.getState().picker).toBeUndefined();
  });

  it("currentModel starts empty", () => {
    expect(new TuiController().getState().currentModel).toBe("");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tui/controller.test.ts`
Expected: FAIL — `c.openPicker` is not a function.

- [ ] **Step 3: Write minimal implementation**

In `src/tui/controller.ts`:

Extend `TuiState`:

```ts
export interface TuiState {
  phase: string;
  detail?: string;
  cards: BoardCardView[];
  pending?: { question: string };
  mode?: "input" | "running" | "picker";
  transcript: { role: "user" | "assistant"; text: string }[];
  queued: number;
  meta?: TurnMeta;
  picker?: { models: string[]; loading: boolean; error?: string };
  currentModel: string;
}
```

Update the initial state field to include `currentModel`:

```ts
  private state: TuiState = { phase: "", cards: [], transcript: [], queued: 0, currentModel: "" };
```

Add the picker methods (anywhere in the class, e.g. after `endRun`):

```ts
  openPicker(): void {
    this.state = { ...this.state, mode: "picker", picker: { models: [], loading: true } };
    this.notify();
  }

  setPickerModels(models: string[]): void {
    this.state = { ...this.state, picker: { models, loading: false } };
    this.notify();
  }

  setPickerError(msg: string): void {
    this.state = { ...this.state, picker: { models: [], loading: false, error: msg } };
    this.notify();
  }

  applyModel(model: string): void {
    this.state = { ...this.state, mode: "input", picker: undefined, currentModel: model };
    this.notify();
  }

  cancelPicker(): void {
    this.state = { ...this.state, mode: "input", picker: undefined };
    this.notify();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tui/controller.test.ts`
Expected: PASS (new tests + existing controller tests).

- [ ] **Step 5: Commit**

```bash
git add src/tui/controller.ts test/tui/controller.test.ts
git commit -m "feat(tui): TuiController picker state (open/set/apply/cancel)"
```

---

### Task 4: `ModelPicker` component

**Files:**
- Create: `src/tui/model-picker.tsx`
- Test: `test/tui/model-picker.test.tsx`

**Interfaces:**
- Produces: `ModelPicker(props: { models: string[]; current: string; loading: boolean; error?: string; cols: number; onSelect: (model: string) => void; onCancel: () => void }): React.ReactElement`. Owns raw stdin: printable → filter; Backspace → delete; ↑/↓ → move selection; Enter → `onSelect(filtered[selected])`; Esc → `onCancel()`.

- [ ] **Step 1: Write the failing test**

```tsx
// test/tui/model-picker.test.tsx
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tui/model-picker.test.tsx`
Expected: FAIL — cannot import `ModelPicker`.

- [ ] **Step 3: Write minimal implementation**

```tsx
// src/tui/model-picker.tsx
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useStdin } from "ink";

const VISIBLE = 10;

export function ModelPicker({ models, current, loading, error, cols, onSelect, onCancel }: {
  models: string[];
  current: string;
  loading: boolean;
  error?: string;
  cols: number;
  onSelect: (model: string) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const filtered = models.filter((m) => m.toLowerCase().includes(filter.toLowerCase()));
  const sel = Math.min(selected, Math.max(0, filtered.length - 1));

  // refs so the raw-stdin handler always sees current values without re-subscribing
  const stRef = useRef({ filtered, sel, loading, error });
  stRef.current = { filtered, sel, loading, error };
  const cbRef = useRef({ onSelect, onCancel });
  cbRef.current = { onSelect, onCancel };

  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  useEffect(() => {
    if (!stdin) return;
    if (isRawModeSupported && setRawMode) setRawMode(true);
    const onData = (chunk: Buffer | string): void => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const st = stRef.current, cb = cbRef.current;
      if (s === "\x1b") { cb.onCancel(); return; } // bare Esc
      if (st.loading || st.error) return; // only Esc works while loading / on error
      if (s === "\x1b[A" || s === "\x1bOA") { setSelected((n) => Math.max(0, n - 1)); return; }
      if (s === "\x1b[B" || s === "\x1bOB") { setSelected((n) => Math.min(st.filtered.length - 1, n + 1)); return; }
      if (s === "\r") { const m = st.filtered[st.sel]; if (m) cb.onSelect(m); return; }
      if (s === "\x7f" || s === "\x08") { setFilter((f) => f.slice(0, -1)); setSelected(0); return; }
      if (s.startsWith("\x1b")) return; // ignore other escape sequences
      if ([...s].every((ch) => ch >= " ")) { setFilter((f) => f + s); setSelected(0); }
    };
    stdin.on("data", onData);
    return () => { stdin.off("data", onData); };
  }, [stdin, setRawMode, isRawModeSupported]);

  const start = Math.max(0, Math.min(sel - Math.floor(VISIBLE / 2), Math.max(0, filtered.length - VISIBLE)));
  const windowed = filtered.slice(start, start + VISIBLE);
  const w = Math.max(10, cols - 2);
  return (
    <Box flexDirection="column" width={w}>
      <Text bold>{`Select model · current: ${current}`}</Text>
      {loading ? (
        <Text dimColor>Loading models…</Text>
      ) : error ? (
        <Text color="red">{`Couldn't fetch models: ${error} · Esc to cancel`}</Text>
      ) : (
        <>
          <Text color="cyan">{`> ${filter}`}</Text>
          {windowed.map((m, i) => {
            const isSel = start + i === sel;
            return (
              <Text key={m} inverse={isSel} wrap="truncate-end">{`${isSel ? "▶ " : "  "}${m}`}</Text>
            );
          })}
          <Text dimColor>↑/↓ move · Enter apply · Esc cancel</Text>
        </>
      )}
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tui/model-picker.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tui/model-picker.tsx test/tui/model-picker.test.tsx
git commit -m "feat(tui): ModelPicker modal (filter + arrows + enter/esc)"
```

---

### Task 5: `App` integration — `/model` dispatch, fetch effect, picker render

**Files:**
- Modify: `src/tui/components.tsx` (`App`)
- Test: `test/tui/components.test.tsx` (append)

**Interfaces:**
- Consumes: `TuiController` picker methods (Task 3); `ModelPicker` (Task 4); `listOmniRouteModels` shape via the `listModels` prop.
- Produces: `App` gains two optional props — `listModels?: () => Promise<string[]>` and `setModel?: (m: string) => void`. Typing `/model` + Enter opens the picker; selecting calls `setModel(m)` then `controller.applyModel(m)`.

- [ ] **Step 1: Write the failing test**

```tsx
// test/tui/components.test.tsx — append a new test at the end of the describe
  it("App: /model opens the picker, lists models, applies a selection", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const clean = (f: string | undefined) => (f ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    const setCalls: string[] = [];
    const c = new TuiController();
    c.awaitTask(); // input mode
    const { stdin, lastFrame, unmount } = render(
      <App controller={c} fullscreen model="init/model"
        listModels={async () => ["a/one", "b/two"]}
        setModel={(m) => setCalls.push(m)} />,
    );
    await sleep(30);
    stdin.write("/model");
    await sleep(20);
    stdin.write("\r"); // submit → opens picker
    await sleep(40);   // fetch resolves
    const f = clean(lastFrame());
    expect(f).toContain("Select model");
    expect(f).toContain("a/one");
    stdin.write("\r"); // pick the first model
    await sleep(30);
    expect(setCalls).toEqual(["a/one"]);
    expect(c.getState().mode).toBe("input");
    expect(c.getState().currentModel).toBe("a/one");
    unmount();
  });
```

(Ensure `TuiController` is imported in the test file — it already is.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tui/components.test.tsx`
Expected: FAIL — no picker renders (`Select model` not found); `App` ignores `/model`.

- [ ] **Step 3: Write minimal implementation**

In `src/tui/components.tsx`:

**(a)** Add the import near the other tui imports:

```tsx
import { ModelPicker } from "./model-picker.js";
```

**(b)** Extend the `App` signature to accept the two new props:

```tsx
export function App({ controller, fullscreen = false, model, listModels, setModel }: {
  controller: TuiController;
  fullscreen?: boolean;
  model?: string;
  listModels?: () => Promise<string[]>;
  setModel?: (m: string) => void;
}): React.ReactElement {
```

**(c)** Add a fetch effect. Place it next to the other `useEffect`s in `App` (top-level hooks, before any early return):

```tsx
  // When the picker opens (loading), fetch the model list once and hand it to the controller.
  useEffect(() => {
    if (state.mode === "picker" && state.picker?.loading && listModels) {
      let cancelled = false;
      listModels().then(
        (models) => { if (!cancelled) controller.setPickerModels(models); },
        (e) => { if (!cancelled) controller.setPickerError(e instanceof Error ? e.message : String(e)); },
      );
      return () => { cancelled = true; };
    }
    return undefined;
  }, [state.mode, state.picker?.loading, listModels, controller]);
```

**(d)** In the fullscreen input box `onSubmit`, add the `/model` dispatch right after the pending-question branch:

Find:
```tsx
              // Pending approval question → the answer routes to controller.answer (single input, no modal).
              if (state.pending) { setScroll(0); setDraft(""); setDraftCursor(0); controller.answer(t); return; }
```
Insert immediately after it:
```tsx
              if (t.trim() === "/model") { setScroll(0); setDraft(""); setDraftCursor(0); controller.openPicker(); return; }
```

**(e)** Add a picker render branch inside the `if (fullscreen) {` block, **immediately after the `const allLines: StyledLine[] = [ ... ];` declaration** (and before `const cw = ...`), so the normal input/running layout computations are skipped when the picker is open. It returns early:

```tsx
    if (state.mode === "picker") {
      const PICKER_H = 14; // header + filter + 10 rows + hint + marginTop (deterministic)
      const viewportH = Math.max(3, size.rows - PICKER_H - 1);
      const maxScroll = Math.max(0, allLines.length - viewportH);
      maxScrollRef.current = maxScroll;
      const clamped = Math.min(scroll, maxScroll);
      const end = allLines.length - clamped;
      const win = allLines.slice(Math.max(0, end - viewportH), end);
      return (
        <Box flexDirection="column" height={size.rows}>
          <ViewportLines lines={win} height={viewportH} />
          <Text dimColor> </Text>
          <Box marginTop={1}>
            <ModelPicker
              models={state.picker?.models ?? []}
              current={state.currentModel || model || "—"}
              loading={state.picker?.loading ?? false}
              error={state.picker?.error}
              cols={size.cols}
              onSelect={(m) => { setModel?.(m); controller.applyModel(m); }}
              onCancel={() => controller.cancelPicker()}
            />
          </Box>
        </Box>
      );
    }
```

(`allLines`, `scroll`, `maxScrollRef`, `size`, `ViewportLines` are all already in scope in the fullscreen block.)

**(f)** Update the metrics fallback so it reflects a live-selected model. Find:
```tsx
        {state.meta ? <MetricsLine meta={state.meta} fallbackModel={model} /> : null}
```
Replace with:
```tsx
        {state.meta ? <MetricsLine meta={state.meta} fallbackModel={state.currentModel || model} /> : null}
```

**(g)** Disable App's scroll `useInput` while the picker is open, so ↑/↓ move the picker selection (via `ModelPicker`'s own stdin handler) instead of scrolling the transcript. Find the `useInput(...)` call's options at the end:
```tsx
  }, { isActive: fullscreen });
```
Replace with:
```tsx
  }, { isActive: fullscreen && state.mode !== "picker" });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tui/components.test.tsx`
Expected: PASS (new test + existing component tests).

- [ ] **Step 5: Commit**

```bash
git add src/tui/components.tsx test/tui/components.test.tsx
git commit -m "feat(tui): /model dispatch + picker render + live-model fetch in App"
```

---

### Task 6: Wiring — `runTuiRepl` + `cli`

**Files:**
- Modify: `src/tui/app.tsx` (`RunTuiReplOpts`, `runTuiRepl`)
- Modify: `src/cli.ts` (build `listModels`, pass to `runTuiRepl`)

**Interfaces:**
- Consumes: `listOmniRouteModels` (Task 1); `deps.roleRegistry.setModelOverride` (Task 2); `App` `listModels`/`setModel` props (Task 5).
- Produces: `RunTuiReplOpts.listModels: () => Promise<string[]>`. `runTuiRepl` derives `setModel` from the built deps and passes both plus the model to `App`.

- [ ] **Step 1: Modify `src/tui/app.tsx`**

Add `listModels` to `RunTuiReplOpts`:

```ts
export interface RunTuiReplOpts {
  buildDeps: (read: LineReader) => JobDeps;
  jobBase: { fromBranch: string; maxRounds: number; revisionRounds?: number };
  formatResult: (res: JobResult) => string;
  model?: string; // configured default model → shown in the metrics line when a call reports no model
  listModels: () => Promise<string[]>; // omniroute model list for the /model picker
}
```

In `runTuiRepl`, after `const deps: JobDeps = { ...deps0, provider: meterProvider(...) };`, add:

```ts
  // /model picker → live-swap every role's model on the running session (no config write).
  const setModel = (m: string): void => deps0.roleRegistry.setModelOverride(m);
```

Change the fullscreen render call from:
```tsx
  const instance = render(<App controller={controller} fullscreen model={opts.model} />);
```
to:
```tsx
  const instance = render(
    <App controller={controller} fullscreen model={opts.model} listModels={opts.listModels} setModel={setModel} />,
  );
```

- [ ] **Step 2: Modify `src/cli.ts`**

Add the import (next to the other provider import):

```ts
import { listOmniRouteModels } from "./providers/models.js";
```

In the `if (!args.prompt) { if (useTui) {` block, before the `await runTuiRepl({...})` call, build the fetcher, and pass it:

```ts
      const { runTuiRepl } = await import("./tui/app.js");
      const listModels = () => listOmniRouteModels({ baseUrl: config.baseUrl, apiKey: config.apiKey });
      await runTuiRepl({
        buildDeps,
        jobBase: { fromBranch, maxRounds: args.rounds ?? 3, ...(args.revisionRounds !== undefined && { revisionRounds: args.revisionRounds }) },
        formatResult: renderResult,
        model: config.model,
        listModels,
      });
      return;
```

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both clean (no type errors; build success).

- [ ] **Step 4: Full suite**

Run: `npm test`
Expected: all tests pass (previous count + the new tests from Tasks 1–5).

- [ ] **Step 5: Commit**

```bash
git add src/tui/app.tsx src/cli.ts
git commit -m "feat(tui): wire /model picker (listModels + setModel) through runTuiRepl and cli"
```

---

## Self-Review

**Spec coverage:**
- §2.1 `listOmniRouteModels` → Task 1. ✅
- §2.2 `RoleRegistry.setModelOverride` → Task 2. ✅
- §2.3 slash-dispatch → Task 5(d). ✅
- §2.4 `ModelPicker` → Task 4. ✅
- §2.5 controller picker state → Task 3. ✅
- §2.6 wiring (`runTuiRepl` + `cli`) → Task 6. ✅
- §3 data flow → Tasks 5 (dispatch+fetch+render) + 6 (setModel wiring). ✅
- §4 error handling → Task 1 (throw) + Task 4 (error render) + Task 5 (setPickerError). ✅
- §5 tests → each task's Step 1. ✅

**Type consistency:** `listModels: () => Promise<string[]>`, `setModel: (m: string) => void`, `setModelOverride(model?: string)`, `applyModel(model: string)`, `setPickerModels(models: string[])`, `ModelPicker` prop names (`models/current/loading/error/cols/onSelect/onCancel`) — all consistent across Tasks 3–6.

**Placeholder scan:** no TBD/TODO; every code step shows full code.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-21-horse-code-model-picker-command.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?
