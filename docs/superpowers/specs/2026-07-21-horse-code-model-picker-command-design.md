# horse-code — `/model` Komutu (Model Seçici) Tasarım Dokümanı

**Tarih:** 2026-07-21
**Durum:** Onaylandı, plana hazır

> Not: Bu doküman Türkçe (mevcut spec konvansiyonu). Uygulanacak **kod, yorum ve testler İngilizce** olacak (kod tabanı "no Turkish" kuralı).

---

## 1. Amaç ve Kapsam

TUI REPL'de `/model` sistem komutu ile kullanıcı, omniroute'taki modelleri listeleyip klavyeyle (yaz-filtrele + ↑/↓ + Enter) seçebilsin. Seçim **çalışan oturuma canlı** uygulanır.

**Kararlar (brainstorming):**
- **Etki:** Sadece bu oturum, **canlı** — seçim bir sonraki turdan itibaren geçerli olur. `~/.horsecode/config.json`'a yazılmaz; `hcode` kapanınca eski modele döner.
- **Liste:** omniroute'taki **tüm** modeller (şu an 236) + **yaz-filtrele** + kayan pencere.

**Tüketir (mevcut, tamam):** J-serisi TUI (`App`, `TuiController`, fullscreen render, `InputLine`); `OmniRouteProvider` (`baseUrl`/`apiKey`); `RoleRegistry.resolve`.

**Konum:** `src/providers/models.ts` (yeni), `src/agent/roles.ts` (`RoleRegistry`), `src/tui/model-picker.tsx` (yeni), `src/tui/components.tsx` (`App` slash-dispatch + picker render), `src/tui/controller.ts` (picker durumu), `src/tui/app.tsx` + `src/cli.ts` (wiring).

### Kapsam DIŞI (YAGNI)
- Config dosyasına kalıcı yazma.
- Genel slash-komut menüsü / otomatik-tamamlama (`/` yazınca açılan menü). Şimdilik sadece tam `/model`.
- Rol-bazlı ayrı model seçimi (tek model tüm rolleri kapsar).
- Model başına yetenek/fiyat gösterimi (sadece `id`).

---

## 2. Bileşenler

### 2.1 `listOmniRouteModels` (`src/providers/models.ts`)

**Ne yapar:** omniroute'un `GET /api/v1/models` ucundan model `id` listesini çeker.

```ts
export async function listOmniRouteModels(opts: {
  baseUrl: string;
  apiKey?: string;
  fetch?: FetchLike; // omniroute.ts'teki FetchLike; test için enjekte edilir
}): Promise<string[]>;
```

- İstek: `GET ${baseUrl}/api/v1/models`, `Authorization: Bearer <apiKey>` (varsa).
- Yanıt: `{ data: [{ id: string }, ...] }` → `id`'ler alınır, **sıralanır**, benzersizleştirilir.
- **Hata:** `!res.ok` veya fetch hatası → anlamlı mesajla `throw` (çağıran picker'da gösterir).
- **Bağımlılık:** yalnız `fetch` (varsayılan `globalThis.fetch`). Provider'dan bağımsız saf fonksiyon.

### 2.2 `RoleRegistry.setModelOverride` (`src/agent/roles.ts`)

**Ne yapar:** Tüm roller için etkin modeli çalışma anında değiştirir (deps yeniden kurmadan).

```ts
// RoleRegistry içinde:
private modelOverride?: string;
setModelOverride(model?: string): void; // undefined → override temizlenir
```

- `resolve()`: `modelOverride` set ise, `role.models[...]` yerine `modelOverride` döndürülür. `systemPrompt` ve skill mantığı **değişmez**. Round-robin `index` mantığına dokunulmaz (override varken atlanır).
- Gerekçe: kullanıcı tek model istiyor; override tüm rollerin (refiner/coach/…) modelini tek seferde değiştirir.

### 2.3 Slash-dispatch (`App` `onSubmit`, `src/tui/components.tsx`)

Fullscreen input `onSubmit` içinde, normal gönderim yolundan **önce**:

```tsx
if (t.trim() === "/model") {
  setScroll(0); setDraft(""); setDraftCursor(0);
  controller.openPicker();
  return; // task olarak gönderme, geçmişe ekleme
}
```

- Yalnız tam `/model` (argümansız). Pending onay sorusu varken `/model` yakalanmaz (normal cevap yolu korunur).

### 2.4 `ModelPicker` bileşeni (`src/tui/model-picker.tsx`)

**Ne yapar:** Filtrelenebilir, klavyeyle gezilen model listesi (geçici modal).

```tsx
export function ModelPicker({
  models, current, loading, error, cols,
  onSelect, onCancel,
}: {
  models: string[];
  current: string;
  loading: boolean;
  error?: string;
  cols: number;
  onSelect: (model: string) => void;
  onCancel: () => void;
}): React.ReactElement;
```

- **Kendi ham stdin'ini yönetir** (`InputLine` deseni): yazılabilir karakter → `filter`'a ekle; Backspace → sil; `↑`/`↓` → seçili indeksi taşır (clamp); `Enter` → `onSelect(filtered[selected])`; `Esc` (`\x1b`) → `onCancel()`.
- **Render (kullanıcı metinleri İngilizce — TUI İngilizce-only):** başlık `Select model · current: {current}`, filtre satırı `> {filter}`, **kayan pencere** liste (~10 satır) filtrelenmiş modellerden; seçili satır ters-video/renk vurgulu; alt ipucu `↑/↓ move · Enter apply · Esc cancel`.
- **Pencere kaydırma:** seçili satır görünürde kalacak şekilde offset. Filtre değişince seçili indeks 0'a döner.
- **Durumlar:** `loading` → `Loading models…`; `error` → `Couldn't fetch models: {msg} · Esc to cancel`.
- Aktifken ana `InputLine` **render edilmez** (tek stdin tüketici → çakışma yok); picker input'un yerini alır.

### 2.5 `TuiController` picker durumu (`src/tui/controller.ts`)

Saf durum makinesi; yan-etki (gerçek model değişimi) App tarafında enjekte edilir.

- **State eklemeleri:**
  - `mode` birleşimine `"picker"` eklenir.
  - `picker?: { models: string[]; loading: boolean; error?: string }`.
  - `currentModel: string` (başlangıçta config modeli).
- **Metotlar:**
  - `openPicker(): void` → `mode="picker"`, `picker={models:[],loading:true}`.
  - `setPickerModels(models: string[]): void` → `picker.models`, `loading=false`.
  - `setPickerError(msg: string): void` → `picker.error`, `loading=false`.
  - `applyModel(model: string): void` → `currentModel=model`, `mode="input"`, `picker=undefined` (yan-etki App'te).
  - `cancelPicker(): void` → `mode="input"`, `picker=undefined`.
- `currentModel` başlangıcı: constructor'a opsiyonel `initialModel` (varsayılan `""`).

### 2.6 Wiring (`src/tui/app.tsx` `runTuiRepl` + `src/cli.ts`)

- `RunTuiReplOpts` alır: `listModels: () => Promise<string[]>` (cli.ts config'ten kurar) — ve mevcut `model` başlangıç modeli olarak.
- `runTuiRepl`: `setModel = (m) => deps0.roleRegistry.setModelOverride(m)`. `App`'e props: `listModels`, `setModel`, `model` (initial).
- `App`:
  - `useEffect`: `mode==="picker" && loading` iken `listModels()` → `controller.setPickerModels` / hata → `controller.setPickerError`.
  - `mode==="picker"` iken `<ModelPicker … onSelect={(m)=>{ setModel(m); controller.applyModel(m); }} onCancel={()=>controller.cancelPicker()} />` render (normal input yerine).
  - Metrik `fallbackModel` = `state.currentModel || model`.

---

## 3. Veri Akışı

```
kullanıcı "/model"⏎
  → App.onSubmit yakalar → controller.openPicker() (mode=picker, loading)
  → App.useEffect → listOmniRouteModels() → controller.setPickerModels(236 id)
  → ModelPicker: filtre + ↑/↓ + Enter
      Enter → App: setModel(m) [roleRegistry.setModelOverride] + controller.applyModel(m)
      Esc   → controller.cancelPicker()
  → mode=input; sonraki turda tüm roller yeni modeli kullanır
     (RoleRegistry.resolve → modelOverride → OmniRouteProvider req.model)
```

---

## 4. Hata Yönetimi

- **Model listesi çekilemezse:** picker `error` durumunu gösterir (`Couldn't fetch models: <msg> · Esc`); seçim yapılmaz, mevcut model korunur.
- **Boş/filtre eşleşmezse:** liste boş; Enter no-op; Esc ile çıkış.
- **Picker fetch'i sürerken job çalışmaz** (picker input-mode benzeri modal; job yalnız task gönderiminde başlar).
- **Geçersiz model seçimi:** liste omniroute'tan geldiği için id'ler geçerli; yine de seçilen model bir sonraki turda upstream hatası verirse mevcut job hata akışı geçerli (kapsam dışı ek doğrulama yok).

---

## 5. Test Stratejisi

- **`listOmniRouteModels`** (fake fetch): `{data:[{id}]}` → sıralı/benzersiz id listesi; `!ok` → throw; sıralama doğrulanır.
- **`RoleRegistry.setModelOverride`:** override set → `resolve()` her rol için override döndürür; `undefined` → config modeline döner; `systemPrompt` etkilenmez.
- **`TuiController` picker:** `openPicker`→mode/picker.loading; `setPickerModels`→models/loading=false; `applyModel`→currentModel+mode=input+picker temiz; `cancelPicker`→mode=input.
- **`ModelPicker`** (ink-testing): liste render + filtre (yazınca eşleşenler süzülür) + ↑/↓ seçili vurgu; Enter `onSelect` çağırır; Esc `onCancel`.
- **App entegrasyon** (ink-testing): `/model`⏎ → picker görünür; model seçimi → `setModel` + `applyModel` çağrılır, input'a dönülür.
- **Regresyon:** tüm suite + `typecheck` + `build` yeşil; mevcut input/running/metrik render değişmez.

---

## 6. Açık Noktalar / İleride

- Görünür satır sayısı (~10) ve pencere kaydırma eşiği ayarlanabilir.
- İleride: kalıcı config yazma (`--persist`), `/model <filtre>` ile ön-filtre, genel `/` komut menüsü, model başına yetenek/fiyat rozeti.
- 236 model için ilk fetch ~<1s; istenirse oturum başına önbelleğe alınabilir (şimdilik her açılışta çekilir).
