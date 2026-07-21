# horse-code Dilim I3 — TUI REPL Tasarım Dokümanı

**Tarih:** 2026-07-21
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md`
**Üst dilim:** I (install/init/interactive). I3 = no-arg `hcode` → TUI REPL. **I dilimi son parçası.**

---

## 1. Amaç ve Kapsam

Argümansız `hcode` (interaktif TTY'de) TUI açar, **görev-input** ekranı gösterir; kullanıcı görevi yazar → canlı board/faz + Q&A → final rapor → tekrar input'a döner (**REPL döngüsü**). Ctrl+C çıkar. I1 (config) + I2 (remote'suz çalışma) üstüne oturur → `hcode` herhangi bir repoda kurulup interaktif kullanılır.

**Kapsam:**
1. **Controller REPL genişletmesi** — `TuiController`'a `mode` (`input`/`running`) + `lastReport` + `awaitTask`/`submitTask`/`beginRun`/`endRun` (additive; tek-shot `runTui` etkilenmez).
2. **App input-mode** — mode'a göre render: input → son rapor + görev-Prompt; running → board/faz/Q&A (mevcut).
3. **`runTuiRepl` driver** — döngü: awaitTask → beginRun → runJob(canlı) → endRun(rapor); hata izolasyonu (bir job çökse REPL sürer).
4. **cli no-arg routing** — argümansız + TTY → `runTuiRepl`; wiring prompt-check öncesine taşınır.

### Kapsam DIŞI
- `hcode "<prompt>"` (argümanlı) tek-shot kalır (mevcut `runTui`, iş bitince çıkar).
- Zengin görsel (scroll, tema), görev-geçmişi kalıcılığı, çoklu-oturum.
- Graceful Ctrl+C cleanup (Ink default exit; done-worktree'ler zaten korunur — kasıtlı).

---

## 2. Controller REPL Genişletmesi (`src/tui/controller.ts`)

`TuiState` additive alanlar kazanır:
```typescript
export interface TuiState {
  phase: string;
  detail?: string;
  cards: BoardCardView[];
  pending?: { question: string };
  mode?: "input" | "running";   // yok → "running" (tek-shot geriye uyum)
  lastReport?: string;
}
```

`TuiController` yeni üyeler (mevcut `onEvent`/`ask`/`answer`/`getState`/`subscribe` değişmez):
```typescript
awaitTask(): Promise<string>;      // mode="input" + notify; kullanıcı submit edene dek bekler
submitTask(task: string): void;    // awaitTask promise'ini çözer (TaskInput onSubmit)
beginRun(): void;                  // mode="running"; cards=[], phase="", detail/pending temizle
endRun(report: string): void;      // mode="input"; lastReport=report
```

- `awaitTask` `ask` gibi tek-pending promise makinesi (ayrı `taskResolve` alanı) — engine seri olduğu gibi REPL de tek-görev-aynı-anda.
- `beginRun` board'u sıfırlar → yeni görev temiz başlar.
- Tek-shot `runTui`: controller `mode` hiç set edilmez → `getState().mode` undefined → App "running" render eder (mevcut davranış).

---

## 3. App Input-Mode (`src/tui/components.tsx`)

`App` mode'a göre dallanır (Board/PhaseBar/Prompt yeniden kullanılır):
```typescript
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

- `Prompt` bileşeni (görev-input + Q&A) aynen kullanılır (H3b).
- `mode` undefined → "running" → tek-shot render byte-identik.

---

## 4. `runTuiRepl` Driver (`src/tui/app.tsx`)

`runTui`'nin (tek-shot) yanına REPL sürücüsü:
```typescript
export interface RunTuiReplOpts {
  buildDeps: (read: LineReader) => JobDeps;
  jobBase: { fromBranch: string; maxRounds: number; revisionRounds?: number };
}

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
        controller.endRun(renderResult(res));
      } catch (e) {
        controller.endRun(`hata: ${e instanceof Error ? e.message : String(e)}`); // REPL hayatta kalır
      }
    }
  } finally {
    instance.unmount();
  }
}
```

- Sonsuz döngü; Ctrl+C (Ink default exit) süreçten çıkar → `finally unmount`.
- Job hatası tek iterasyonda yutulur (`endRun` ile raporlanır) → REPL sürer.
- `deps` bir kez kurulur (controller.ask stabil); her görev yeni `openSession` (done'da worktree korunur — birikir, kasıtlı I sırası).
- `renderResult`/`toSlug` import edilir (cli'den taşınmaz; app.tsx kendi import eder).

---

## 5. cli No-arg Routing (`src/cli.ts`)

`main` yeniden düzenlenir: config/provider/manager/`buildDeps`/`fromBranch` wiring'i **prompt-check ÖNCESİNE** taşınır (REPL de aynı wiring'i kullanır).

```
const args = parseArgs(argv);
if (argv[0] === "init") { ... return; }              // I1 (değişmez)
const cwd = process.cwd();
// config/provider/skillRegistry/manager/prAdapter/buildDeps/fromBranch (prompt'tan bağımsız)
const useTui = shouldUseTui(!!process.stdin.isTTY, !!process.stdout.isTTY, !!args.noTui);

if (!args.prompt) {
  if (useTui) {
    const { runTuiRepl } = await import("./tui/app.js");
    await runTuiRepl({ buildDeps, jobBase: { fromBranch, maxRounds: args.rounds ?? 3, ...(args.revisionRounds !== undefined && { revisionRounds: args.revisionRounds }) } });
    return;
  }
  console.error('kullanım: hcode "<prompt>" [...] | hcode (interaktif TUI REPL) | hcode init');
  process.exitCode = 1;
  return;
}

// prompt VAR → mevcut tek-shot (useTui ? runTui : düz readline akışı)
const jobName = args.jobName ?? (toSlug(args.prompt) || "hcode-job");
const job = { prompt: args.prompt, fromBranch, jobName, maxRounds: args.rounds ?? 3, ...(revisionRounds) };
if (useTui) { const { runTui } = await import("./tui/app.js"); ... } else { düz readline ... }
```

- `init` dalı en başta (I1) korunur.
- Wiring taşınır ama tek-shot (prompt'lu) yol davranışça aynı kalır.
- non-TTY + prompt-yok → usage (REPL yalnız interaktif TTY'de).

---

## 6. Test Stratejisi

- **Controller REPL (saf birim):** `awaitTask` mode="input" + notify → `submitTask(t)` promise'i `t` ile çözer; `beginRun` mode="running" + board sıfır; `endRun(r)` mode="input" + lastReport=r; tek-shot geriye uyum (`mode` undefined → getState).
- **App (ink-testing-library):** mode="input" → "Görevini yaz" + lastReport frame'de; mode="running" → board frame'de; mode undefined → running (tek-shot korunur).
- **`runTuiRepl`/cli no-arg:** gerçek Ink + runJob döngüsü → **birim test EDİLMEZ**; parçaları test edilir; **manuel** (`hcode` interaktif) doğrulanır.
- Regresyon: tüm suite + typecheck + build yeşil; tek-shot `runTui` + `hcode "<prompt>"` değişmez.

> Not: Subagent limiti (200/200) dolduğu için bu dilim **inline** (controller doğrudan implement + self-review) yürütülür; TDD + task-başı commit korunur.

---

## 7. Açık Noktalar / İleride

- Ctrl+C hard-exit → son job worktree'si (done'da) korunur; REPL boyunca `.worktrees/` birikir (kasıtlı; ileride `hcode --gc`).
- Görev-input'ta çok-satır/düzenleme yok (ham `useInput`); ileride ink-text-input.
- REPL'de bir görev sürerken yeni görev alınmaz (tek-görev-aynı-anda; `awaitTask` bir sonraki iterasyonda).
- `readline/promises` piped-race (I1 deferred) REPL'i etkilemez (TUI stdin ham `useInput`, readline değil).
