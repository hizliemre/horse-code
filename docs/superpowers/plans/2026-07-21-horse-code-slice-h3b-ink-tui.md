# Dilim H3b — Ink TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** H3a ilerleme event'lerini görsel bir **Ink TUI**'ye bağla; `hcode` interaktif TTY'de TUI, pipe/CI'da düz terminal (H2).

**Architecture:** `TuiController` (saf state-machine) runJob'un async seam'lerini React state'ine köprüler; `ask(q)` düz bir `LineReader` olduğu için H2'nin `makeAskUser`/`makeApprove`/`makeAskHuman` builder'ları hiç değişmeden yeniden kullanılır. Ink bileşenleri (`Board`/`PhaseBar`/`Prompt`/`App`) controller'a subscribe olur. `runTui` controller+seam+render+runJob'ı bağlar; cli `shouldUseTui(isTTY, noTui)` ile dallanır ve TUI dalında ink'i **dinamik import** eder (düz mod + mevcut testler ink yüklemez).

**Tech Stack:** TypeScript ESM, React 18, ink 5, vitest + ink-testing-library.

## Global Constraints

- TypeScript ESM, Node ≥20, `strict`; relative import'lar `.js` son ekli (`.tsx` dosyalar da `.js` ile import edilir — bundler resolution).
- vitest, **TDD**. Saf birimler (`TuiController`, `shouldUseTui`, `parseArgs`) unit; Ink bileşenleri `ink-testing-library` frame testi; `runTui`/`main` tam entegrasyonu **otomatik test edilmez** (manuel).
- **Geriye dönük uyum:** düz terminal akışı (H2) davranışça korunur; mevcut tüm testler yeşil kalır. TUI yalnız `process.stdout.isTTY && !--no-tui` iken aktif.
- **Reuse:** H2 `makeAskUser`/`makeApprove`/`makeAskHuman(read: LineReader)` (src/terminal.ts) aynen; `buildJobDeps` (src/wiring.ts); H1 `runJob`/`JobResult`/`JobDeps` (src/engine/job.ts); H3a `ProgressEvent`/`BoardCardView` (src/engine/progress.ts). Yeni parse/pipeline mantığı YAZILMAZ.
- **Deps:** `dependencies`'e `ink@^5`, `react@^18`; `devDependencies`'e `@types/react@^18`, `ink-testing-library@^4`. ink-text-input / ink-spinner **eklenmez** (ham `useInput`, sade gösterge).

---

### Task 1: Bağımlılıklar + config + `TuiController`

**Files:**
- Modify: `package.json` (deps), `tsconfig.json` (jsx), `tsup.config.ts` (splitting), `vitest.config.ts` (tsx include)
- Create: `src/tui/controller.ts`
- Test: `test/tui/controller.test.ts`

**Interfaces:**
- Consumes: H3a `ProgressEvent`, `BoardCardView` (`src/engine/progress.ts`).
- Produces:
  - `interface TuiState { phase: string; detail?: string; cards: BoardCardView[]; pending?: { question: string } }`
  - `class TuiController` — `onEvent(ev: ProgressEvent): void` (arrow-bound), `ask(question: string): Promise<string>` (arrow-bound, `LineReader` uyumlu), `answer(text: string): void`, `getState(): TuiState`, `subscribe(fn: () => void): () => void` (unsubscribe döner).

- [ ] **Step 1: Bağımlılıkları kur**

Run:
```bash
npm install ink@^5 react@^18
npm install -D @types/react@^18 ink-testing-library@^4
```
Expected: `package.json`'a 4 paket eklenir, kurulum başarılı.

- [ ] **Step 2: Config güncellemeleri**

`tsconfig.json` — `compilerOptions`'a ekle (`"strict": true` satırından sonra herhangi bir yere):
```json
    "jsx": "react-jsx",
    "jsxImportSource": "react",
```

`tsup.config.ts` — `clean: true,` satırından sonra ekle (dinamik import chunk'ı emit edilsin):
```typescript
  splitting: true,
```

`vitest.config.ts` — `include` satırını değiştir:
```typescript
    include: ["test/**/*.test.{ts,tsx}"],
```

- [ ] **Step 3: Kırmızı test**

`test/tui/controller.test.ts` oluştur:
```typescript
import { describe, it, expect } from "vitest";
import { TuiController } from "../../src/tui/controller.js";

describe("TuiController", () => {
  it("onEvent phase → state.phase günceller + listener çağrılır", () => {
    const c = new TuiController();
    let notified = 0;
    c.subscribe(() => { notified++; });
    c.onEvent({ kind: "phase", phase: "waves", detail: "x" });
    expect(c.getState().phase).toBe("waves");
    expect(c.getState().detail).toBe("x");
    expect(notified).toBe(1);
  });

  it("onEvent board → state.cards günceller", () => {
    const c = new TuiController();
    c.onEvent({ kind: "board", cards: [{ id: "a", title: "A", column: "TODO" }] });
    expect(c.getState().cards).toEqual([{ id: "a", title: "A", column: "TODO" }]);
  });

  it("ask pending set eder + notify; answer promise'i çözer + pending temizler", async () => {
    const c = new TuiController();
    let notified = 0;
    c.subscribe(() => { notified++; });
    const p = c.ask("Devam?");
    expect(c.getState().pending).toEqual({ question: "Devam?" });
    expect(notified).toBe(1);
    c.answer("evet");
    expect(await p).toBe("evet");
    expect(c.getState().pending).toBeUndefined();
    expect(notified).toBe(2);
  });

  it("getState mutasyonda yeni referans döner (React re-render için)", () => {
    const c = new TuiController();
    const s0 = c.getState();
    c.onEvent({ kind: "phase", phase: "p" });
    expect(c.getState()).not.toBe(s0);
  });

  it("subscribe dönüşü unsubscribe eder", () => {
    const c = new TuiController();
    let n = 0;
    const off = c.subscribe(() => { n++; });
    c.onEvent({ kind: "phase", phase: "a" });
    off();
    c.onEvent({ kind: "phase", phase: "b" });
    expect(n).toBe(1);
  });
});
```

- [ ] **Step 4: Testi çalıştır — kırmızı**

Run: `npx vitest run test/tui/controller.test.ts`
Expected: FAIL — `src/tui/controller.js` yok.

- [ ] **Step 5: `TuiController` implement**

`src/tui/controller.ts` oluştur:
```typescript
import type { BoardCardView, ProgressEvent } from "../engine/progress.js";

export interface TuiState {
  phase: string;
  detail?: string;
  cards: BoardCardView[];
  pending?: { question: string };
}

/** runJob'un async seam'lerini (onEvent + ask) React state'ine köprüler. Saf state-machine. */
export class TuiController {
  private state: TuiState = { phase: "", cards: [] };
  private pendingResolve?: (s: string) => void;
  private listeners = new Set<() => void>();

  getState(): TuiState {
    return this.state;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  // arrow-bound: runJob'a onEvent olarak geçilir (this korunur)
  onEvent = (ev: ProgressEvent): void => {
    if (ev.kind === "phase") this.state = { ...this.state, phase: ev.phase, detail: ev.detail };
    else this.state = { ...this.state, cards: ev.cards };
    this.notify();
  };

  // arrow-bound: LineReader olarak geçilir → makeAskUser/makeApprove/makeAskHuman ile reuse
  ask = (question: string): Promise<string> =>
    new Promise<string>((resolve) => {
      this.pendingResolve = resolve;
      this.state = { ...this.state, pending: { question } };
      this.notify();
    });

  answer(text: string): void {
    const resolve = this.pendingResolve;
    this.pendingResolve = undefined;
    this.state = { ...this.state, pending: undefined };
    this.notify();
    resolve?.(text);
  }
}
```

- [ ] **Step 6: Testi çalıştır — yeşil**

Run: `npx vitest run test/tui/controller.test.ts`
Expected: PASS (5/5).

- [ ] **Step 7: Tüm suite + typecheck (regresyon: config değişimi mevcut testleri bozmasın)**

Run: `npm test && npm run typecheck`
Expected: tüm testler yeşil (mevcut 315 + yeni 5), typecheck temiz.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsup.config.ts vitest.config.ts src/tui/controller.ts test/tui/controller.test.ts
git commit -m "feat: ink/react deps + jsx config + TuiController (async↔React köprüsü)"
```

---

### Task 2: Ink bileşenleri (`Board`/`PhaseBar`/`Prompt`/`App`)

**Files:**
- Create: `src/tui/components.tsx`
- Test: `test/tui/components.test.tsx`

**Interfaces:**
- Consumes: `BoardCardView` (`src/engine/progress.ts`), `Column` (`src/board/board.ts`), `TuiController`/`TuiState` (`src/tui/controller.ts`).
- Produces (hepsi React function component):
  - `Board({ cards }: { cards: BoardCardView[] })` — 4 kolon (TODO/IN-PROGRESS/REVIEW/DONE), her kolonda o kolondaki kart title'ları.
  - `PhaseBar({ phase, detail }: { phase: string; detail?: string })` — "Faz: <phase>[ — <detail>]".
  - `Prompt({ question, onSubmit }: { question: string; onSubmit: (s: string) => void })` — soru + `useInput` buffer; Enter → `onSubmit`.
  - `App({ controller }: { controller: TuiController })` — controller'a subscribe; `<PhaseBar/>` + `<Board/>` + (pending ? `<Prompt/>` : null).

- [ ] **Step 1: Kırmızı test**

`test/tui/components.test.tsx` oluştur:
```tsx
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { Board, PhaseBar, Prompt, App } from "../../src/tui/components.js";
import { TuiController } from "../../src/tui/controller.js";

describe("Ink bileşenleri", () => {
  it("Board kart title'larını ve kolon başlıklarını gösterir", () => {
    const { lastFrame } = render(
      <Board cards={[
        { id: "1", title: "Alfa", column: "TODO" },
        { id: "2", title: "Beta", column: "DONE" },
      ]} />,
    );
    const f = lastFrame() ?? "";
    expect(f).toContain("TODO");
    expect(f).toContain("DONE");
    expect(f).toContain("Alfa");
    expect(f).toContain("Beta");
  });

  it("PhaseBar fazı ve detayı gösterir", () => {
    const { lastFrame } = render(<PhaseBar phase="waves" detail="running" />);
    const f = lastFrame() ?? "";
    expect(f).toContain("waves");
    expect(f).toContain("running");
  });

  it("Prompt soruyu ve girdi işaretçisini gösterir", () => {
    const { lastFrame } = render(<Prompt question="Devam?" onSubmit={() => {}} />);
    const f = lastFrame() ?? "";
    expect(f).toContain("Devam?");
    expect(f).toContain(">");
  });

  it("App başlangıç state'ini render eder (faz + kartlar)", () => {
    const c = new TuiController();
    c.onEvent({ kind: "phase", phase: "board" });
    c.onEvent({ kind: "board", cards: [{ id: "1", title: "Görev", column: "IN-PROGRESS" }] });
    const { lastFrame } = render(<App controller={c} />);
    const f = lastFrame() ?? "";
    expect(f).toContain("board");
    expect(f).toContain("Görev");
  });

  it("App pending soru varsa Prompt render eder", () => {
    const c = new TuiController();
    void c.ask("Onaylıyor musun?");
    const { lastFrame } = render(<App controller={c} />);
    expect(lastFrame() ?? "").toContain("Onaylıyor musun?");
  });
});
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/tui/components.test.tsx`
Expected: FAIL — `src/tui/components.js` yok.

- [ ] **Step 3: Bileşenleri implement**

`src/tui/components.tsx` oluştur:
```tsx
import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { BoardCardView } from "../engine/progress.js";
import type { Column } from "../board/board.js";
import type { TuiController } from "./controller.js";

const COLUMNS: Column[] = ["TODO", "IN-PROGRESS", "REVIEW", "DONE"];

export function Board({ cards }: { cards: BoardCardView[] }): React.ReactElement {
  return (
    <Box>
      {COLUMNS.map((col) => (
        <Box key={col} flexDirection="column" marginRight={2}>
          <Text bold>{col}</Text>
          {cards.filter((c) => c.column === col).map((c) => (
            <Text key={c.id}>{c.title}</Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}

export function PhaseBar({ phase, detail }: { phase: string; detail?: string }): React.ReactElement {
  return <Text>Faz: {phase}{detail ? ` — ${detail}` : ""}</Text>;
}

export function Prompt({ question, onSubmit }: { question: string; onSubmit: (s: string) => void }): React.ReactElement {
  const [buf, setBuf] = useState("");
  useInput((input, key) => {
    if (key.return) {
      onSubmit(buf);
      setBuf("");
    } else if (key.backspace || key.delete) {
      setBuf((b) => b.slice(0, -1));
    } else if (input) {
      setBuf((b) => b + input);
    }
  });
  return (
    <Box flexDirection="column">
      <Text>{question}</Text>
      <Text>{"> "}{buf}</Text>
    </Box>
  );
}

export function App({ controller }: { controller: TuiController }): React.ReactElement {
  const [state, setState] = useState(controller.getState());
  useEffect(() => controller.subscribe(() => setState(controller.getState())), [controller]);
  return (
    <Box flexDirection="column">
      <PhaseBar phase={state.phase} detail={state.detail} />
      <Board cards={state.cards} />
      {state.pending ? <Prompt question={state.pending.question} onSubmit={(s) => controller.answer(s)} /> : null}
    </Box>
  );
}
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/tui/components.test.tsx`
Expected: PASS (5/5).

- [ ] **Step 5: Tüm suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: tüm testler yeşil, typecheck temiz.

- [ ] **Step 6: Commit**

```bash
git add src/tui/components.tsx test/tui/components.test.tsx
git commit -m "feat: Ink bileşenleri (Board/PhaseBar/Prompt/App)"
```

---

### Task 3: `runTui` + cli TTY dallanması

**Files:**
- Create: `src/tui/app.tsx`
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts` (mevcut dosyaya ekle; yoksa oluştur)

**Interfaces:**
- Consumes: `TuiController` (arrow `onEvent`/`ask`), `App` (`src/tui/components.ts`), `makeAskUser`/`LineReader` (`src/terminal.ts`), `runJob`/`JobDeps`/`JobResult` (`src/engine/job.ts`), `render`/`unmount` (ink), `buildJobDeps` + `makeApprove`/`makeAskHuman` (cli tarafında).
- Produces:
  - `src/tui/app.tsx`: `interface RunTuiOpts { buildDeps: (read: LineReader) => JobDeps; job: { prompt: string; fromBranch: string; jobName: string; maxRounds: number; revisionRounds?: number; prTitle?: string } }` ve `runTui(opts: RunTuiOpts): Promise<JobResult>`.
  - `src/cli.ts`: `CliArgs.noTui?: boolean`; `shouldUseTui(isTTY: boolean, noTui: boolean): boolean`.

- [ ] **Step 1: `runTui` yaz (test yok — manuel doğrulanır)**

`src/tui/app.tsx` oluştur:
```tsx
import React from "react";
import { render } from "ink";
import type { LineReader } from "../terminal.js";
import { makeAskUser } from "../terminal.js";
import { runJob } from "../engine/job.js";
import type { JobDeps, JobResult } from "../engine/job.js";
import { TuiController } from "./controller.js";
import { App } from "./components.js";

export interface RunTuiOpts {
  buildDeps: (read: LineReader) => JobDeps;
  job: { prompt: string; fromBranch: string; jobName: string; maxRounds: number; revisionRounds?: number; prTitle?: string };
}

/** Ink TUI: controller kur → seam'ler controller.ask üzerinden → App render → runJob → unmount. */
export async function runTui(opts: RunTuiOpts): Promise<JobResult> {
  const controller = new TuiController();
  const read: LineReader = (q) => controller.ask(q);
  const deps = opts.buildDeps(read);
  const instance = render(<App controller={controller} />);
  try {
    return await runJob(deps, {
      ...opts.job,
      askUser: makeAskUser(read),
      onEvent: controller.onEvent,
    });
  } finally {
    instance.unmount();
  }
}
```

- [ ] **Step 2: cli kırmızı test**

`test/cli.test.ts`'e ekle (dosya yoksa oluştur — import satırını mevcut testlerle birleştir):
```typescript
import { describe, it, expect } from "vitest";
import { parseArgs, shouldUseTui } from "../src/cli.js";

describe("cli TUI dallanması", () => {
  it("parseArgs --no-tui bayrağını okur", () => {
    expect(parseArgs(["--no-tui", "yap", "bir", "şey"]).noTui).toBe(true);
    expect(parseArgs(["yap", "bir", "şey"]).noTui).toBeUndefined();
  });

  it("shouldUseTui: TTY var ve --no-tui yok → true", () => {
    expect(shouldUseTui(true, false)).toBe(true);
  });

  it("shouldUseTui: TTY yok → false (pipe/CI)", () => {
    expect(shouldUseTui(false, false)).toBe(false);
  });

  it("shouldUseTui: --no-tui → false (TTY olsa bile)", () => {
    expect(shouldUseTui(true, true)).toBe(false);
  });
});
```

- [ ] **Step 3: Testi çalıştır — kırmızı**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL — `shouldUseTui` export yok / `noTui` yok.

- [ ] **Step 4: cli güncelle**

`src/cli.ts`:

(a) import'lara `LineReader` ve `JobDeps` ekle:
```typescript
import { makeAskUser, makeApprove, makeAskHuman, nodeLineReader } from "./terminal.js";
import type { LineReader } from "./terminal.js";
import { runJob } from "./engine/job.js";
import type { JobResult, JobDeps } from "./engine/job.js";
```

(b) `CliArgs` interface'ine ekle:
```typescript
  noTui?: boolean;
```

(c) `parseArgs` içinde `noTui` topla — döngüde `--revision-rounds` dalından sonra ekle:
```typescript
    else if (a === "--no-tui") noTui = true;
```
döngü öncesi `let noTui: boolean | undefined;` tanımla (`let revisionRounds` yanına), ve return objesine ekle:
```typescript
    ...(noTui !== undefined && { noTui }),
```

(d) `renderResult`'tan sonra `shouldUseTui` ekle:
```typescript
export function shouldUseTui(isTTY: boolean, noTui: boolean): boolean {
  return isTTY && !noTui;
}
```

(e) usage satırına `[--no-tui]` ekle:
```typescript
    console.error('kullanım: hcode "<prompt>" [--branch b] [--job j] [--rounds n] [--revision-rounds n] [--no-tui]');
```

(f) `main`'in seam+runJob bölümünü değiştir. `prAdapter` kurulumundan sonraki `const { read, close } = nodeLineReader();` ... `finally { close(); }` bloğunun TAMAMINI şununla değiştir:
```typescript
  const fromBranch = args.fromBranch ?? (await currentBranch(cwd));
  const jobName = args.jobName ?? (toSlug(args.prompt) || "hcode-job");
  const buildDeps = (read: LineReader): JobDeps =>
    buildJobDeps({
      config, provider, skillRegistry, manager, prAdapter,
      askHuman: makeAskHuman(read),
      approve: makeApprove(read),
      signal: new AbortController().signal,
    });
  const job = {
    prompt: args.prompt, fromBranch, jobName,
    maxRounds: args.rounds ?? 3,
    ...(args.revisionRounds !== undefined && { revisionRounds: args.revisionRounds }),
  };

  if (shouldUseTui(!!process.stdout.isTTY, !!args.noTui)) {
    const { runTui } = await import("./tui/app.js"); // ink'i yalnız TUI dalında yükle
    const res = await runTui({ buildDeps, job });
    console.log(renderResult(res));
    return;
  }

  const { read, close } = nodeLineReader();
  try {
    const deps = buildDeps(read);
    const res = await runJob(deps, { ...job, askUser: makeAskUser(read) });
    console.log(renderResult(res));
  } finally {
    close(); // stdin'i kapat → süreç asılı kalmasın
  }
```

Not: `fromBranch`/`jobName` artık bu blokta hesaplanıyor; eski konumlarındaki (nodeLineReader try bloğu içindeki) tanımları kaldırıldı — yukarıdaki değişiklik bunu zaten kapsıyor.

- [ ] **Step 5: Testi çalıştır — yeşil**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS.

- [ ] **Step 6: Tüm suite + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: tüm testler yeşil; typecheck temiz; `npm run build` `dist/cli.js` (+ ink chunk) üretir, hata yok.

- [ ] **Step 7: Düz-mod manuel duman testi (ink yüklenmediğini doğrula)**

Run: `echo "" | node dist/cli.js "test" 2>&1 | head -5`
Expected: pipe olduğu için düz mod (TUI değil); OmniRoute config yoksa hata mesajı düz metin olarak yazılır — Ink render'ı devreye girmez (çökme yok).

- [ ] **Step 8: Commit**

```bash
git add src/tui/app.tsx src/cli.ts test/cli.test.ts
git commit -m "feat: runTui + cli otomatik TTY dallanması (--no-tui, ink dinamik import)"
```

---

## Self-Review Notu

- **Spec coverage:** §2 deps+jsx → Task 1 Step 1-2; §3 TuiController → Task 1 Step 5; §4 Ink bileşenleri → Task 2; §5.1 runTui → Task 3 Step 1; §5.2 shouldUseTui + --no-tui + main dallanma → Task 3 Step 4; §6 test stratejisi → her task'ın testleri (controller/shouldUseTui/parseArgs saf; bileşenler ink-testing-library; runTui/main manuel Step 7). Tümü karşılandı.
- **Type consistency:** `TuiController.ask` `(string)=>Promise<string>` = `LineReader`; `onEvent` `(ProgressEvent)=>void` = runJob opts.onEvent; `App` props `{controller}`; `runTui` `RunTuiOpts.buildDeps: (LineReader)=>JobDeps` + `job` runJob opts alt-kümesi (maxRounds zorunlu, revisionRounds/prTitle opsiyonel); `shouldUseTui(boolean,boolean)=>boolean`. cli `buildDeps`/`job` runTui ve düz dalda ortak.
- **Geriye dönük uyum:** düz terminal akışı korunur (nodeLineReader dalı); TUI yalnız TTY'de + --no-tui yokken; ink dinamik import → mevcut cli/parseArgs testleri ink yüklemez. Task 1 Step 7 + Task 3 Step 6 tam suite ile doğrular.
- **Config riski:** `vitest.config.ts` include `.tsx` eklendi (aksi halde components.test.tsx koşmaz); `tsup splitting:true` (dinamik import chunk'ı); tsconfig `jsx:react-jsx` (skipLibCheck:true → @types/react DOM-lib referansları takılmaz, lib'de DOM yok; exactOptionalPropertyTypes kapalı → `detail: undefined` sorun değil).
- **Placeholder taraması:** yok — her adımda tam kod / tam komut.
