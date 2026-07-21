# Dilim I3 — TUI REPL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **NOT:** Subagent limiti (200/200) dolu → bu plan **inline** (executing-plans) yürütülür: her task TDD + commit, controller kendi self-review'unu yapar.

**Goal:** Argümansız `hcode` (TTY) → TUI görev-input → canlı board → rapor → döngü (Ctrl+C çıkış).

**Architecture:** `TuiController`'a additive REPL üyeleri (`mode`/`lastReport` + awaitTask/submitTask/beginRun/endRun); `App` mode'a göre render; `runTuiRepl` hata-izole döngü; cli no-arg+TTY → REPL. `formatResult` enjekte edilir (app→cli import-cycle yok). Tek-shot `runTui` + `hcode "<prompt>"` değişmez.

**Tech Stack:** TypeScript ESM, React 18/ink 5, vitest + ink-testing-library.

## Global Constraints

- TypeScript ESM, Node ≥20, `strict`; `.js`-suffixed import (`.tsx` dahil).
- vitest, **TDD**. Controller REPL saf birim; App ink-testing-library; `runTuiRepl`/cli no-arg **manuel**.
- **Additive geriye uyum:** `mode` undefined → "running" → tek-shot `runTui` + `hcode "<prompt>"` byte-identik. Mevcut controller/App/runTui testleri yeşil kalır.
- Regresyon: tüm suite + typecheck + build yeşil.

---

### Task 1: Controller REPL genişletmesi

**Files:**
- Modify: `src/tui/controller.ts`
- Test: `test/tui/controller.test.ts`

**Interfaces:**
- Produces: `TuiState` += `mode?: "input" | "running"; lastReport?: string`; `TuiController` += `awaitTask(): Promise<string>`, `submitTask(task: string): void`, `beginRun(): void`, `endRun(report: string): void`.

- [ ] **Step 1: Kırmızı test**

`test/tui/controller.test.ts`'e ekle:
```typescript
  it("awaitTask mode=input + notify; submitTask promise'i çözer", async () => {
    const c = new TuiController();
    let n = 0; c.subscribe(() => { n++; });
    const p = c.awaitTask();
    expect(c.getState().mode).toBe("input");
    expect(n).toBe(1);
    c.submitTask("bir görev");
    expect(await p).toBe("bir görev");
  });

  it("beginRun mode=running + board/phase sıfırlar", () => {
    const c = new TuiController();
    c.onEvent({ kind: "board", cards: [{ id: "a", title: "A", column: "TODO" }] });
    c.onEvent({ kind: "phase", phase: "waves" });
    c.beginRun();
    expect(c.getState().mode).toBe("running");
    expect(c.getState().cards).toEqual([]);
    expect(c.getState().phase).toBe("");
  });

  it("endRun mode=input + lastReport", () => {
    const c = new TuiController();
    c.endRun("rapor metni");
    expect(c.getState().mode).toBe("input");
    expect(c.getState().lastReport).toBe("rapor metni");
  });

  it("tek-shot: mode set edilmezse undefined (geriye uyum)", () => {
    expect(new TuiController().getState().mode).toBeUndefined();
  });
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/tui/controller.test.ts`
Expected: FAIL — `awaitTask`/`submitTask`/`beginRun`/`endRun` yok.

- [ ] **Step 3: Controller implement**

`src/tui/controller.ts`:
- `TuiState`'e ekle (`pending?` satırından sonra):
```typescript
  mode?: "input" | "running";
  lastReport?: string;
```
- class'a alan ekle (`private pendingResolve?` yanına): `private taskResolve?: (t: string) => void;`
- `answer(...)` metodundan sonra ekle:
```typescript
  awaitTask(): Promise<string> {
    return new Promise<string>((resolve) => {
      this.taskResolve = resolve;
      this.state = { ...this.state, mode: "input" };
      this.notify();
    });
  }

  submitTask(task: string): void {
    const resolve = this.taskResolve;
    this.taskResolve = undefined;
    resolve?.(task);
  }

  beginRun(): void {
    this.state = { ...this.state, mode: "running", cards: [], phase: "", detail: undefined, pending: undefined };
    this.notify();
  }

  endRun(report: string): void {
    this.state = { ...this.state, mode: "input", lastReport: report };
    this.notify();
  }
```

- [ ] **Step 4: Testi çalıştır — yeşil**

Run: `npx vitest run test/tui/controller.test.ts`
Expected: PASS (yeni + mevcut controller testleri).

- [ ] **Step 5: Tüm suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: yeşil, temiz.

- [ ] **Step 6: Commit**

```bash
git add src/tui/controller.ts test/tui/controller.test.ts
git commit -m "feat: TuiController REPL üyeleri (mode/lastReport + awaitTask/beginRun/endRun)"
```

---

### Task 2: App input-mode

**Files:**
- Modify: `src/tui/components.tsx`
- Test: `test/tui/components.test.tsx`

**Interfaces:**
- Consumes: `TuiController` (`mode`/`lastReport`/`submitTask`), `Prompt`/`Board`/`PhaseBar`.
- Produces: `App` mode="input" → lastReport + görev-Prompt; mode undefined/"running" → board (mevcut).

- [ ] **Step 1: Kırmızı test**

`test/tui/components.test.tsx`'e ekle:
```tsx
  it("App input mode: görev-input + son rapor gösterir", () => {
    const c = new TuiController();
    c.endRun("İş bitti: (yerel: hc/x/base)");
    const { lastFrame } = render(<App controller={c} />);
    const f = lastFrame() ?? "";
    expect(f).toContain("Görevini yaz");
    expect(f).toContain("İş bitti");
  });

  it("App input mode (rapor yok): sadece görev-input", () => {
    const c = new TuiController();
    void c.awaitTask();
    expect((render(<App controller={c} />).lastFrame() ?? "")).toContain("Görevini yaz");
  });

  it("App mode undefined → running (tek-shot korunur, board render)", () => {
    const c = new TuiController();
    c.onEvent({ kind: "board", cards: [{ id: "1", title: "Görev", column: "TODO" }] });
    const f = render(<App controller={c} />).lastFrame() ?? "";
    expect(f).toContain("Görev");
    expect(f).not.toContain("Görevini yaz");
  });
```

- [ ] **Step 2: Testi çalıştır — kırmızı**

Run: `npx vitest run test/tui/components.test.tsx`
Expected: FAIL — App input-mode dalı yok ("Görevini yaz" render edilmiyor).

- [ ] **Step 3: App implement**

`src/tui/components.tsx` — `App`'i değiştir:
```tsx
export function App({ controller }: { controller: TuiController }): React.ReactElement {
  const [state, setState] = useState(controller.getState());
  useEffect(() => controller.subscribe(() => setState(controller.getState())), [controller]);
  const mode = state.mode ?? "running";
  if (mode === "input") {
    return (
      <Box flexDirection="column">
        {state.lastReport ? <Text>{state.lastReport}</Text> : null}
        <Prompt question="Görevini yaz (Ctrl+C çıkış):" onSubmit={(t) => controller.submitTask(t)} />
      </Box>
    );
  }
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
Expected: PASS (yeni input-mode + mevcut running/board testleri).

- [ ] **Step 5: Tüm suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: yeşil, temiz.

- [ ] **Step 6: Commit**

```bash
git add src/tui/components.tsx test/tui/components.test.tsx
git commit -m "feat: App input-mode (görev-input + son rapor; running mode değişmez)"
```

---

### Task 3: `runTuiRepl` driver + cli no-arg routing

**Files:**
- Modify: `src/tui/app.tsx` (`runTuiRepl`)
- Modify: `src/cli.ts` (no-arg REPL routing + wiring taşıma)

**Interfaces:**
- Consumes: `TuiController` (awaitTask/beginRun/endRun/onEvent/ask), `App`, `runJob`/`JobResult`, `makeAskUser`, `toSlug` (`../worktree/slug.js`).
- Produces: `runTuiRepl(opts: { buildDeps: (read: LineReader) => JobDeps; jobBase: { fromBranch: string; maxRounds: number; revisionRounds?: number }; formatResult: (res: JobResult) => string }): Promise<void>`.

- [ ] **Step 1: `runTuiRepl` yaz (test yok — manuel doğrulanır)**

`src/tui/app.tsx`:
- import ekle: `import { toSlug } from "../worktree/slug.js";`
- `runTui`'den sonra ekle:
```tsx
export interface RunTuiReplOpts {
  buildDeps: (read: LineReader) => JobDeps;
  jobBase: { fromBranch: string; maxRounds: number; revisionRounds?: number };
  formatResult: (res: JobResult) => string;
}

/** TUI REPL: görev-input → canlı job → rapor → döngü. Ctrl+C çıkar; job hatası izole. */
export async function runTuiRepl(opts: RunTuiReplOpts): Promise<void> {
  const controller = new TuiController();
  const read: LineReader = (q) => controller.ask(q);
  const deps = opts.buildDeps(read);
  const instance = render(<App controller={controller} />);
  try {
    for (;;) {
      const task = await controller.awaitTask();
      controller.beginRun();
      try {
        const res = await runJob(deps, {
          ...opts.jobBase,
          prompt: task,
          jobName: toSlug(task) || "hcode-job",
          askUser: makeAskUser(read),
          onEvent: controller.onEvent,
        });
        controller.endRun(opts.formatResult(res));
      } catch (e) {
        controller.endRun(`hata: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    instance.unmount();
  }
}
```

- [ ] **Step 2: cli no-arg routing — wiring'i taşı + REPL dalı**

`src/cli.ts` `main`'i yeniden düzenle. Mevcut `if (!args.prompt) { console.error(...); return; }` bloğu KALDIRILIR; wiring (config/provider/skillRegistry/manager/prAdapter/fromBranch/buildDeps) prompt-check ÖNCESİNE alınır; sonra REPL/tek-shot dallanır. `parseArgs` sonrası (init dalından sonra) gövde şöyle olur:

```typescript
  const cwd = process.cwd();
  const config = loadConfig({
    cwd, home: process.env.HOME ?? "", env: process.env,
    readFile: (p) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } },
  });
  const provider = new OmniRouteProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey });
  const skillRegistry = new SkillRegistry();
  const skillsDir = join(cwd, ".horsecode", "skills");
  if (existsSync(skillsDir)) await skillRegistry.loadFromDir(skillsDir);
  const manager = new WorktreeManager({ repoRoot: cwd });
  const remoteUrl = (await defaultGitRunner(["remote", "get-url", "origin"], cwd)).stdout.trim();
  const prAdapter = makePRAdapter({ platform: detectPlatform(remoteUrl), run: defaultCmdRunner, cwd, log: (s) => console.log(s) });
  const fromBranch = args.fromBranch ?? (await currentBranch(cwd));
  const buildDeps = (read: LineReader): JobDeps =>
    buildJobDeps({
      config, provider, skillRegistry, manager, prAdapter,
      askHuman: makeAskHuman(read), approve: makeApprove(read),
      signal: new AbortController().signal,
    });
  const useTui = shouldUseTui(!!process.stdin.isTTY, !!process.stdout.isTTY, !!args.noTui);

  if (!args.prompt) {
    if (useTui) {
      const { runTuiRepl } = await import("./tui/app.js");
      await runTuiRepl({
        buildDeps,
        jobBase: { fromBranch, maxRounds: args.rounds ?? 3, ...(args.revisionRounds !== undefined && { revisionRounds: args.revisionRounds }) },
        formatResult: renderResult,
      });
      return;
    }
    console.error('kullanım: hcode "<prompt>" [--branch b] [--job j] [--rounds n] [--revision-rounds n] [--no-tui]  |  hcode (interaktif TUI REPL)  |  hcode init');
    process.exitCode = 1;
    return;
  }

  const jobName = args.jobName ?? (toSlug(args.prompt) || "hcode-job");
  const job = {
    prompt: args.prompt, fromBranch, jobName,
    maxRounds: args.rounds ?? 3,
    ...(args.revisionRounds !== undefined && { revisionRounds: args.revisionRounds }),
  };

  if (useTui) {
    const { runTui } = await import("./tui/app.js");
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
    close();
  }
```

(NOT: `init` dalı `main`'in en başında, `parseArgs`'tan hemen sonra korunur — bu blok ondan sonrasıdır. Eski `if (!args.prompt) usage` erken bloğu ve eski job/dallanma silinir; yukarıdaki tek gövde onların yerine geçer — çift tanım kalmamalı, `npm run typecheck` doğrular.)

- [ ] **Step 3: Tüm suite + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: yeşil; typecheck temiz (tek `job`/`jobName`/`buildDeps` tanımı); `dist/cli.js` build olur.

- [ ] **Step 4: Manuel/otomatik duman testleri**

Run:
```bash
# non-TTY no-arg → usage (REPL değil, hang yok)
node dist/cli.js < /dev/null 2>&1 | head -3
# tek-shot prompt'lu yol hâlâ çalışır (chat, izole repo)
```
Expected: no-arg + non-TTY → yeni usage satırı (`hcode (interaktif TUI REPL)` içerir), exit 1, hang yok. İnteraktif `hcode` REPL'i **manuel** (gerçek TTY + LLM) doğrulanır.

- [ ] **Step 5: Commit**

```bash
git add src/tui/app.tsx src/cli.ts
git commit -m "feat: runTuiRepl + cli no-arg TUI REPL routing (wiring prompt-öncesine)"
```

---

## Self-Review Notu

- **Spec coverage:** §2 controller → Task 1; §3 App → Task 2; §4 runTuiRepl → Task 3 Step 1; §5 cli routing → Task 3 Step 2. Tümü karşılandı.
- **Type consistency:** `TuiState.mode?/lastReport?`; `awaitTask(): Promise<string>`, `submitTask/beginRun/endRun`; `RunTuiReplOpts` (buildDeps/jobBase/formatResult); `formatResult: (JobResult)=>string` = `renderResult` imzası; `toSlug` import.
- **Additive geriye uyum:** `mode` undefined → "running" → tek-shot `runTui`/`App`/`hcode "<prompt>"` değişmez (Task 1 Step 4 + Task 2 Step 4 mevcut testlerle doğrular). cli wiring taşınır ama tek-shot yol davranışça aynı.
- **Import-cycle yok:** `formatResult` enjekte (app.tsx cli'yi import etmez); `toSlug` app→worktree (düz).
- **Hata izolasyonu:** runTuiRepl job-try/catch → endRun ile raporlar, döngü sürer.
- **Placeholder taraması:** yok — her adımda tam kod / tam komut.
