# Dilim J1 — Sohbet UX Temeli Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). Steps use checkbox (`- [ ]`).
> **NOT:** Subagent limiti dolu → inline yürütülür: her task TDD + commit.

**Goal:** Transcript (kalıcı mesaj) + rol-ayrımı + kutulu input + HORSE CODE splash.

**Architecture:** Controller `lastReport`→`transcript`. `App` **her zaman** `<Static>`(splash+transcript) render eder (mode-switch'te remount → tekrar-basma olmasın), altında dinamik bölge input-box veya board'a dallanır. Ink `<Static>` mesajları stdout'a bir kez yazar → scroll'da kalır.

**Tech Stack:** TypeScript ESM, React 18/ink 5, vitest + ink-testing-library.

## Global Constraints

- TypeScript ESM, `strict`; `.js`-suffixed import (`.tsx` dahil).
- vitest, **TDD**. Bileşenler `ink-testing-library`; controller saf.
- **`<Static>` + test:** transcript/splash Static'e gider (lastFrame'de olmayabilir) → transcript metnini App üzerinden lastFrame ile ASSERT ETME; `Message`/`Splash`'i **doğrudan** test et, App'te yalnız **dinamik** kısmı (hint/board) assert et.
- **Additive:** tek-shot `runTui` running-mode render'ı davranışça korunur (board dinamik alanda; splash Static header eklenir — zararsız).
- Regresyon: tüm suite + typecheck + build yeşil.

---

### Task 1: Controller transcript

**Files:**
- Modify: `src/tui/controller.ts`
- Test: `test/tui/controller.test.ts`

**Interfaces:**
- `TuiState`: `lastReport?` kaldırılır, `transcript: { role: "user" | "assistant"; text: string }[]` eklenir.
- `submitTask` transcript'e user; `endRun` transcript'e assistant; `beginRun` transcript'i korur.

- [ ] **Step 1: Testleri güncelle/ekle (kırmızı)**

`test/tui/controller.test.ts` — mevcut `it("endRun mode=input + lastReport", ...)` bloğunu ŞUNLARLA değiştir:
```typescript
  it("submitTask user mesajını transcript'e ekler", async () => {
    const c = new TuiController();
    const p = c.awaitTask();
    c.submitTask("görev-1");
    await p;
    expect(c.getState().transcript).toEqual([{ role: "user", text: "görev-1" }]);
  });

  it("endRun assistant mesajını ekler + mode=input", () => {
    const c = new TuiController();
    c.endRun("rapor metni");
    expect(c.getState().mode).toBe("input");
    expect(c.getState().transcript).toEqual([{ role: "assistant", text: "rapor metni" }]);
  });

  it("beginRun transcript'i korur (board sıfırlar)", () => {
    const c = new TuiController();
    c.endRun("önceki");
    c.beginRun();
    expect(c.getState().transcript).toEqual([{ role: "assistant", text: "önceki" }]);
    expect(c.getState().cards).toEqual([]);
  });
```

- [ ] **Step 2: Kırmızı doğrula**

Run: `npx vitest run test/tui/controller.test.ts`
Expected: FAIL — `transcript` yok / `lastReport` referansı.

- [ ] **Step 3: Controller implement**

`src/tui/controller.ts`:
- `TuiState` içindeki `lastReport?: string;` satırını **sil**, yerine ekle: `transcript: { role: "user" | "assistant"; text: string }[];`
- Başlangıç state: `private state: TuiState = { phase: "", cards: [] };` → `private state: TuiState = { phase: "", cards: [], transcript: [] };`
- `submitTask`:
```typescript
  submitTask(task: string): void {
    const resolve = this.taskResolve;
    this.taskResolve = undefined;
    this.state = { ...this.state, transcript: [...this.state.transcript, { role: "user", text: task }] };
    this.notify();
    resolve?.(task);
  }
```
- `endRun`:
```typescript
  endRun(report: string): void {
    this.state = { ...this.state, mode: "input", transcript: [...this.state.transcript, { role: "assistant", text: report }] };
    this.notify();
  }
```
- `beginRun` değişmez (spread transcript'i korur).

- [ ] **Step 4: Yeşil + tüm suite**

Run: `npx vitest run test/tui/controller.test.ts && npm test`
Expected: yeşil (App testleri Task 2'de güncellenecek — şimdilik lastReport referansı varsa kırmızı kalabilir; o testler Task 2'de düzelir. Bu task için controller.test yeşil yeterli, tam suite Task 2 sonunda).

> Not: `components.test.tsx` `lastReport` kullanıyorsa bu adımda kırmızı olabilir → Task 2'de birlikte yeşile alınır. Task 1 commit'i controller-only.

- [ ] **Step 5: typecheck (App henüz lastReport kullanıyorsa geçici tip hatası olabilir)**

`src/tui/components.tsx` App hâlâ `state.lastReport` okuyorsa typecheck kırmızı olur → Task 2'de düzelir. Task 1'i commit etmek için typecheck'i Task 2 ile birlikte yeşile al; VEYA Task 1'de App'in `lastReport` satırını geçici olarak kaldır (Task 2 zaten App'i yeniden yazacak). **Öneri:** Task 1 + Task 2'yi ardışık yap, tek typecheck/commit Task 2 sonunda. Task 1 commit'i yalnız controller+controller.test (izole yeşil).

- [ ] **Step 6: Commit (controller)**

```bash
git add src/tui/controller.ts test/tui/controller.test.ts
git commit -m "feat: TuiController transcript (lastReport yerine kalıcı mesaj log'u)"
```

---

### Task 2: Bileşenler — InputLine + Message + Splash + App (Static)

**Files:**
- Modify: `src/tui/components.tsx`
- Test: `test/tui/components.test.tsx`

**Interfaces:**
- `InputLine({ onSubmit })` — girdi-yakalama (useInput+buf), `> {buf}` render.
- `Message({ role, text })` — rol-stilli satır.
- `Splash()` — HORSE CODE + ASCII at-kafası.
- `App` — `<Static>`(splash+transcript) + dinamik (input-box | board).

- [ ] **Step 1: Testleri güncelle/ekle (kırmızı)**

`test/tui/components.test.tsx`:
- import'a `Message`, `Splash` ekle (mevcut `Board, PhaseBar, Prompt, App` yanına).
- Mevcut `it("App input mode: görev-input + son rapor gösterir", ...)` ve `it("App input mode (rapor yok): ...")` bloklarını ŞUNLARLA değiştir:
```typescript
  it("Message user → 'sen' prefix + metin", () => {
    const f = render(<Message role="user" text="selam dünya" />).lastFrame() ?? "";
    expect(f).toContain("sen");
    expect(f).toContain("selam dünya");
  });

  it("Message assistant → 'hcode' prefix + metin", () => {
    const f = render(<Message role="assistant" text="merhaba" />).lastFrame() ?? "";
    expect(f).toContain("hcode");
    expect(f).toContain("merhaba");
  });

  it("Splash HORSE CODE içerir", () => {
    expect(render(<Splash />).lastFrame() ?? "").toContain("HORSE CODE");
  });

  it("App input mode: görev-input hint + kutu render eder", () => {
    const c = new TuiController();
    void c.awaitTask();
    expect(render(<App controller={c} />).lastFrame() ?? "").toContain("Görevini yaz");
  });
```
(Mevcut `it("App mode undefined → running ...")` testi KALIR — board dinamik alanda, lastFrame'de görünür.)

- [ ] **Step 2: Kırmızı doğrula**

Run: `npx vitest run test/tui/components.test.tsx`
Expected: FAIL — `Message`/`Splash` export yok.

- [ ] **Step 3: components.tsx implement**

`src/tui/components.tsx`:
- import satırını değiştir: `import { Box, Text, useInput, Static } from "ink";`
- `Prompt`'u InputLine kullanacak şekilde değiştir + yeni bileşenler ekle:
```tsx
export function InputLine({ onSubmit }: { onSubmit: (s: string) => void }): React.ReactElement {
  const [buf, setBuf] = useState("");
  useInput((input, key) => {
    if (key.return) { onSubmit(buf); setBuf(""); }
    else if (key.backspace || key.delete) setBuf((b) => b.slice(0, -1));
    else if (input) setBuf((b) => b + input);
  });
  return <Text>{"> "}{buf}</Text>;
}

export function Prompt({ question, onSubmit }: { question: string; onSubmit: (s: string) => void }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text>{question}</Text>
      <InputLine onSubmit={onSubmit} />
    </Box>
  );
}

export function Message({ role, text }: { role: "user" | "assistant"; text: string }): React.ReactElement {
  return role === "user"
    ? <Text><Text color="cyan" bold>{"› sen: "}</Text>{text}</Text>
    : <Text><Text color="green" bold>{"🐴 hcode: "}</Text>{text}</Text>;
}

export function Splash(): React.ReactElement {
  return (
    <Box marginBottom={1}>
      <Box flexDirection="column" marginRight={2}>
        <Text color="yellow">{"  ▄██▄"}</Text>
        <Text color="yellow">{" ▟████▙"}</Text>
        <Text color="yellow">{"▟██████▙"}</Text>
        <Text color="yellow">{"▜███████"}</Text>
        <Text color="yellow">{" ▀▀▜███▙"}</Text>
        <Text color="yellow">{"     ▀██"}</Text>
      </Box>
      <Box flexDirection="column">
        <Text> </Text>
        <Text> </Text>
        <Text color="yellow" bold>{"H O R S E   C O D E"}</Text>
        <Text dimColor>{"çok-ajanlı kodlama mekanizması"}</Text>
      </Box>
    </Box>
  );
}
```
- `App`'i yeniden yaz (Static her zaman mount + dinamik dallanma):
```tsx
export function App({ controller }: { controller: TuiController }): React.ReactElement {
  const [state, setState] = useState(controller.getState());
  useEffect(() => controller.subscribe(() => setState(controller.getState())), [controller]);
  const mode = state.mode ?? "running";
  type Item = { kind: "splash" } | { kind: "msg"; role: "user" | "assistant"; text: string };
  const items: Item[] = [{ kind: "splash" }, ...state.transcript.map((m) => ({ kind: "msg" as const, role: m.role, text: m.text }))];
  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item, i) => item.kind === "splash"
          ? <Splash key={i} />
          : <Message key={i} role={item.role} text={item.text} />}
      </Static>
      {mode === "input" ? (
        <Box flexDirection="column">
          <Text dimColor>Görevini yaz (Ctrl+C çıkış)</Text>
          <Box borderStyle="round" borderColor="gray" paddingX={1}>
            <InputLine onSubmit={(t) => controller.submitTask(t)} />
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          <PhaseBar phase={state.phase} detail={state.detail} />
          <Board cards={state.cards} />
          {state.pending ? <Prompt question={state.pending.question} onSubmit={(s) => controller.answer(s)} /> : null}
        </Box>
      )}
    </Box>
  );
}
```

- [ ] **Step 4: Yeşil + tüm suite + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: yeşil (controller + components + mevcut hepsi); typecheck temiz (lastReport artık yok); `dist/cli.js` build.

- [ ] **Step 5: Manuel duman**

Run: `node dist/cli.js < /dev/null 2>&1 | head -3` (non-TTY → usage; hang yok).
İnteraktif `hcode` (splash + kutulu input + transcript) **manuel** doğrulanır.

- [ ] **Step 6: Commit**

```bash
git add src/tui/components.tsx test/tui/components.test.tsx
git commit -m "feat: sohbet UX — Static transcript + Message rol-stil + Splash + kutulu input"
```

---

## Self-Review Notu

- **Spec coverage:** §2 transcript → Task 1; §3.1 InputLine, §3.2 Message, §3.3 Splash, §3.4 App/Static → Task 2. Tümü.
- **Type consistency:** `TuiState.transcript`; `submitTask/endRun` push; `InputLine/Message/Splash` imzaları; App `Static items` union tipli.
- **Static remount önlemi:** Static App'te HER ZAMAN mount (mode dinamik alanda dallanır) → input↔running geçişinde transcript tekrar basılmaz.
- **Test/Static:** transcript lastFrame'de olmayabilir → Message/Splash doğrudan test, App'te dinamik (hint/board) assert.
- **Additive:** tek-shot running-mode board dinamik alanda korunur; splash Static header zararsız.
- **Placeholder taraması:** yok.
