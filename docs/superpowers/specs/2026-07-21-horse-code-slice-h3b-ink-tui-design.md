# horse-code Dilim H3b — Ink TUI Tasarım Dokümanı

**Tarih:** 2026-07-21
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md`
**Üst dilim:** H3 (TUI). H3b = Ink görsel katmanı (H3a event'lerini tüketir). **Mekanizmanın son parçası.**

---

## 1. Amaç ve Kapsam

H3a'nın ilerleme event'lerini görsel bir **Ink TUI**'ye çevirir: canlı board grid (TODO/IN-PROGRESS/
REVIEW/DONE), aktif faz, ve Q&A (askUser/askHuman/approve) Ink input'ları. `hcode` **otomatik**:
interaktif TTY'de TUI, pipe/CI'da düz terminal (H2). `--no-tui` TUI'yi zorla kapatır.

**Tüketir (tamam):** H3a `ProgressEvent`/`snapshotBoard`; H2 `makeAskUser`/`makeApprove`/`makeAskHuman`
(`LineReader` üzerinden — controller.ask ile reuse), `buildJobDeps`, cli; H1 `runJob`/`JobResult`.

Konum: `src/tui/controller.ts` (TuiController), `src/tui/components.tsx` (Ink bileşenleri),
`src/tui/app.ts` (runTui), `src/cli.ts` (TTY tespiti), `package.json`/`tsconfig.json` (deps + jsx).

### Kapsam DIŞI (H3b değil)
- **Fine upstream event'leri** (H3a kaba faz) — TUI kaba fazı gösterir.
- **Zengin animasyon/spinner-lib** — sade gösterge (ek dep yok).
- **Yeni pipeline mantığı** — H3b saf görsel; runJob değişmez.

---

## 2. Bağımlılıklar + JSX

- **dependencies:** `ink` (^5), `react` (^18). **devDependencies:** `@types/react` (^18),
  `ink-testing-library` (^4). (Ink ESM-only; proje zaten ESM.)
- **tsconfig:** `"jsx": "react-jsx"`, `"jsxImportSource": "react"` (yalnız `.tsx` etkilenir; başka .tsx yok).
- tsup `.tsx`'i bundle'lar; `dist/cli.js` girişi değişmez (TUI cli'den dallanır).

---

## 3. `TuiController` (`controller.ts`) — Async ↔ React Köprüsü

Saf state-machine (React'siz, testlenebilir). runJob'un async seam'lerini React state'ine bağlar.

```typescript
export interface TuiState { phase: string; detail?: string; cards: BoardCardView[]; pending?: { question: string } }

export class TuiController {
  onEvent(ev: ProgressEvent): void;         // phase/board state'i günceller + notify
  ask(question: string): Promise<string>;   // LineReader! pending set + notify; promise döner
  answer(text: string): void;               // pending çöz + temizle + notify + promise.resolve(text)
  getState(): TuiState;
  subscribe(fn: () => void): () => void;     // React useEffect için
}
```

- **Reuse:** `const read: LineReader = (q) => controller.ask(q)` → `makeAskUser(read)`/
  `makeApprove(read)`/`makeAskHuman(read)` (H2). Yeni parse mantığı YOK — controller.ask düz bir LineReader.
- `onEvent` runJob'a; `ask`'tan türeyen seam'ler runJob opts/deps'e verilir.

---

## 4. Ink Bileşenleri (`components.tsx`)

```typescript
export function Board({ cards }: { cards: BoardCardView[] }): JSX.Element;
  // 4 kolon (TODO/IN-PROGRESS/REVIEW/DONE); her kolonda o kolondaki kartların title'ları. Ink <Box>/<Text>.
export function PhaseBar({ phase, detail }: { phase: string; detail?: string }): JSX.Element;
  // "Faz: <phase> — <detail>" tek satır.
export function Prompt({ question, onSubmit }: { question: string; onSubmit: (s: string) => void }): JSX.Element;
  // <Text> soru + useInput ile karakter yakala; Enter → onSubmit(buffer). Yerel buffer state'i.
export function App({ controller }: { controller: TuiController }): JSX.Element;
  // useState(controller.getState()) + useEffect(subscribe→setState); <PhaseBar/> + <Board/> + (pending ? <Prompt onSubmit={controller.answer}/> : null).
```

Sade Ink (Box/Text/useInput); ink-text-input/ink-spinner **yok** (dep minimal).

---

## 5. `runTui` (`app.ts`) + cli TTY Tespiti

### 5.1 `runTui(depsBase, jobOpts): Promise<JobResult>`

`depsBase = { config, provider, skillRegistry, manager, prAdapter }`; `jobOpts = { prompt, fromBranch,
jobName, maxRounds, revisionRounds?, prTitle? }`.

```
controller = new TuiController()
read = (q) => controller.ask(q)
deps = buildJobDeps({ ...depsBase, approve: makeApprove(read), askHuman: makeAskHuman(read) })
{ unmount } = render(<App controller={controller} />)   // ink render
res = await runJob(deps, { ...jobOpts, askUser: makeAskUser(read), onEvent: controller.onEvent })
unmount()
return res
```

### 5.2 cli TTY tespiti

- `parseArgs` kazanır `--no-tui` (boolean).
- `shouldUseTui(isTTY: boolean, noTui: boolean): boolean = isTTY && !noTui` (saf, testlenebilir).
- `main`: `if (shouldUseTui(!!process.stdout.isTTY, !!args.noTui)) { res = await runTui(depsBase, jobOpts) }
  else { /* H2 düz akış: readline seam'leri + runJob */ }`. İki dalda da sonda `renderResult(res)` yazdırılır.

---

## 6. Test Stratejisi

- **TuiController (saf):** `onEvent` phase/board → state günceller + subscribe listener çağrılır; `ask`
  pending set + notify → `answer(text)` promise'i `text` ile çözer + pending temizler.
- **Ink bileşenleri (`ink-testing-library`):** `render(<Board cards=[...]/>).lastFrame()` kart title +
  kolonları içerir; `<PhaseBar phase="waves"/>` "waves" içerir; `<Prompt question="X?"/>` soruyu gösterir;
  `<App controller/>` state değişince (controller.onEvent) frame güncellenir; pending'de Prompt render olur.
- **shouldUseTui (saf):** `(true,false)→true`, `(false,false)→false`, `(true,true)→false`.
- **parseArgs `--no-tui`.**
- **runTui/main entegrasyonu** (gerçek Ink render + runJob) birim test EDİLMEZ — parçaları test edilir;
  manuel `hcode --tui`/`hcode | cat` ile doğrulanır.

Tümü `vitest`; controller/shouldUseTui saf, bileşenler `ink-testing-library`.

---

## 7. H3b DIŞI (bilinçli ertelenen)

- **Fine faz event'leri** (spec/plan/council adım adım) → ileride (H3a threading).
- **Zengin görsel** (renkli tema, spinner animasyonu, scrollable log) → ileride.
- **runTui tam-entegrasyon otomasyon testi** → manuel.

---

## 8. Açık Noktalar / İleride

- `render` (ink) süreç yaşam döngüsünü yönetir; `runJob` bitince `unmount()` + `renderResult` yazdırılır.
  Q&A sırasında Ink stdin'i tutar; H2'nin readline'ıyla çakışmaması için TUI dalında readline kullanılmaz.
- `App` her event'te re-render; `snapshotBoard` zaten hafif (kart listesi). Büyük board'da React dedupe eder.
- Ink deps'i CI/headless'ta yüklü olmalı; TUI yalnız TTY'de aktif (pipe/CI düz moda düşer, Ink render'ı çağrılmaz).
- `useInput` ham girdi yakalar (backspace/enter yönetimi bileşende); gelişmiş satır düzenleme ileride.
