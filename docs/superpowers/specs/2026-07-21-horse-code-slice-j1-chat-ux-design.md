# horse-code Dilim J1 — Sohbet UX Temeli Tasarım Dokümanı

**Tarih:** 2026-07-21
**Durum:** Onaylandı, plana hazır
**Üst dilim:** J (TUI redesign — "Claude Code hissi"). J1 = sohbet UX temeli.

---

## 1. Amaç ve Kapsam

TUI'yi düz-terminal görünümünden sohbet-benzeri, markalı bir arayüze taşı:
1. **Transcript** — kullanıcı + asistan mesajları scroll'da kalıcı (kaybolmaz).
2. **Rol ayrımı** — `› sen` (cyan) vs `🐴 hcode` (yeşil) renk + prefix.
3. **Kutulu input** — yuvarlak-kenarlı box.
4. **Splash** — açılışta `HORSE CODE` wordmark + ASCII at-kafası.

**Kilit teknik:** Ink `<Static>` → transcript öğeleri stdout'a **bir kez** yazılır (scroll geçmişinde kalır, re-render'da silinmez). Dinamik alt-bölge yalnız input kutusu. Bu, mesajın kaybolması sorununu (#1) kökten çözer.

### Kapsam DIŞI (sonraki alt-dilimler)
- **J2:** faz etiketleri ("Rafine ediliyor…") + koşan-at animasyonu + spinner.
- **J3:** geçen-süre + model + token metrikleri.
- Tek-shot `runTui` + `hcode "<prompt>"` render'ı (J1 yalnız REPL input-mode'unu değiştirir; running-mode J2'ye).

---

## 2. Controller — Transcript (`src/tui/controller.ts`)

`TuiState`: `lastReport?` **kaldırılır**, yerine transcript:
```typescript
export interface TuiState {
  phase: string;
  detail?: string;
  cards: BoardCardView[];
  pending?: { question: string };
  mode?: "input" | "running";
  transcript: { role: "user" | "assistant"; text: string }[];
}
```

- Başlangıç state: `{ phase: "", cards: [], transcript: [] }`.
- `submitTask(task)`: transcript'e `{ role: "user", text: task }` ekle + notify, sonra resolve.
- `endRun(report)`: transcript'e `{ role: "assistant", text: report }` ekle, `mode: "input"`, notify.
- `beginRun()`: `mode: "running"`, board/phase sıfırla — **transcript korunur** (sohbet geçmişi silinmez).

Tek-shot `runTui`: transcript'e hiç dokunmaz (default `[]`) → running-mode render değişmez.

---

## 3. Bileşenler (`src/tui/components.tsx`)

### 3.1 `InputLine({ onSubmit })` — yeniden kullanılabilir girdi
`Prompt`'un girdi-yakalama mantığını (useInput + buffer) ayrı bileşene çıkar; yalnız `> {buf}` render eder.
```typescript
export function InputLine({ onSubmit }: { onSubmit: (s: string) => void }): React.ReactElement;
```
`Prompt` (running-mode Q&A) bunu kullanır: `<Box column><Text>{question}</Text><InputLine .../></Box>` (davranış aynı).

### 3.2 `Message({ role, text })` — rol-stilli satır
```typescript
export function Message({ role, text }: { role: "user" | "assistant"; text: string }): React.ReactElement;
// user → <Text color="cyan">› sen: </Text> + text
// assistant → <Text color="green">🐴 hcode: </Text> + text
```

### 3.3 `Splash()` — marka açılışı
`HORSE CODE` wordmark + ASCII at-kafası + tagline, renkli bordered box. (Kesin art plan'da; block-art at kafası + "H O R S E   C O D E" + "çok-ajanlı kodlama mekanizması".)

### 3.4 `App` — input-mode (Static + kutulu input)
```typescript
if (mode === "input") {
  return (
    <Box flexDirection="column">
      <Static items={[{ kind: "splash" }, ...state.transcript.map((m) => ({ kind: "msg", ...m }))]}>
        {(item, i) => item.kind === "splash"
          ? <Splash key="splash" />
          : <Message key={i} role={item.role} text={item.text} />}
      </Static>
      <Text dimColor>Görevini yaz (Ctrl+C çıkış)</Text>
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <InputLine onSubmit={(t) => controller.submitTask(t)} />
      </Box>
    </Box>
  );
}
```
- `<Static>` splash'ı ve transcript'i **bir kez** yazar (scroll'da kalır); yeni mesaj gelince Static'e eklenir → geçmişin üstüne yazılır, input kutusu altta kalır.
- Splash ilk Static öğesi → açılışta en üstte görünür, sohbet ilerledikçe yukarı kayar.
- Running-mode render J1'de **değişmez** (J2 ele alacak).

---

## 4. Test Stratejisi

- **Controller:** `submitTask` transcript'e user mesajı ekler + notify; `endRun` assistant mesajı ekler + mode input; `beginRun` transcript'i korur (board sıfırlar); tek-shot mode undefined + transcript `[]`.
- **Bileşenler (ink-testing-library):** `Message` role'e göre prefix/renk; `Splash` "HORSE CODE" içerir; `App` input-mode transcript mesajlarını + "Görevini yaz" + kutulu input render eder; mode undefined → running (değişmez).
- Mevcut testler: `lastReport`→`transcript` geçişi için controller/App testleri güncellenir (endRun sonrası assistant mesajı frame'de).
- Regresyon: tüm suite + typecheck + build yeşil; tek-shot yolu değişmez.

---

## 5. Açık Noktalar / İleride

- `<Static>` öğeleri sabit; çok uzun asistan raporu terminalde doğal scroll'lanır (Ink kesmez).
- Splash her REPL oturumunda bir kez (Static ilk öğe); art J1'de temel, ileride pixel-pixel iyileştirilebilir.
- Running-mode (job sürerken) J1'de eski haliyle; J2 faz-etiketi + animasyon ekleyecek.
- Q&A Prompt (running-mode) J1'de kutusuz; J2 tutarlılık için kutulayabilir.
