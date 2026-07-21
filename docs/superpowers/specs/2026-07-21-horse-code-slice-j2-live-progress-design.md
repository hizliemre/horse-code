# horse-code Dilim J2 — Canlı İlerleme Tasarım Dokümanı

**Tarih:** 2026-07-21
**Durum:** Onaylandı, plana hazır
**Üst dilim:** J (TUI redesign). J2 = canlı ilerleme (faz-etiketleri + koşan-at animasyonu).

---

## 1. Amaç ve Kapsam

Job sürerken kullanıcı "ne oluyor" görsün, interaksiyon hissedilsin:
1. **Dostça faz etiketleri** — içsel faz adları ("upstream", "waves"…) → Türkçe okunur etiketler ("Rafine ediliyor…", "Kodlanıyor…").
2. **Koşan-at animasyonu** — job işlenirken bir at (🐎) parça-parça koşar (spinner yerine marka-uyumlu canlı gösterge).

**Tüketir (tamam):** H3a `ProgressEvent` (onEvent fazları); J1 App/controller (running-mode render, `mode: "running"`).

**Konum:** `src/tui/progress-view.tsx` (`RunningHorse` + `ProgressView`), `src/tui/labels.ts` (faz→etiket), `src/tui/components.tsx` (App running-mode).

### Kapsam DIŞI
- **J3:** geçen-süre + model + token metrikleri.
- Fine upstream event'leri (spec/plan/council adım-adım) — kaba faz.
- Board görselleştirme değişikliği (mevcut kalır; J2 faz-etiketi + animasyon ekler).

---

## 2. Faz Etiketleri (`src/tui/labels.ts`)

İçsel faz → Türkçe dostça etiket:
```typescript
export const PHASE_LABELS: Record<string, string> = {
  upstream: "İsteğin anlaşılıyor / rafine ediliyor…",
  chat: "Yanıtlanıyor…",
  rejected: "Onaylanmadı",
  approved: "Spec + plan onaylandı",
  board: "Görevler çıkarılıyor…",
  waves: "Kodlanıyor…",
  "waves-done": "Kodlama tamamlandı",
  pr: "PR hazırlanıyor…",
  revision: "Gözden geçiriliyor…",
  "revision-done": "Revizyon tamamlandı",
  report: "Rapor hazırlanıyor…",
  done: "Tamamlandı ✓",
};
export function phaseLabel(phase: string): string { return PHASE_LABELS[phase] ?? phase; }
```

---

## 3. Koşan-At Animasyonu (`src/tui/progress-view.tsx`)

### 3.1 `RunningHorse`
Bir 🐎 kısa bir "pist" üzerinde koşar; kareler timer ile döner.
```typescript
export function RunningHorse(): React.ReactElement;
// useState(frame) + useEffect(setInterval ~130ms → frame++), unmount'ta clearInterval.
// pos = frame % (TRACK+1); render: "·"×pos + "🐎" + "·"×(TRACK-pos), renkli.
```
- Sürekli döngü (job boyunca), unmount'ta (job bitince → input-mode) interval temizlenir → sızıntı yok.
- Ink re-render'ı frame state'i ile tetiklenir (yalnız bu bileşen, hafif).

### 3.2 `ProgressView`
```typescript
export function ProgressView({ phase, detail }: { phase: string; detail?: string }): React.ReactElement;
// <RunningHorse/> + phaseLabel(phase) (bold) + (detail ? " — detail" dim : null)
```

---

## 4. App Running-Mode (`src/tui/components.tsx`)

Running-mode'da `PhaseBar` yerine `ProgressView` kullanılır (Board + pending korunur):
```tsx
) : (
  <Box flexDirection="column">
    <ProgressView phase={state.phase} detail={state.detail} />
    <Board cards={state.cards} />
    {state.pending ? <Prompt ... /> : null}
  </Box>
)
```
`PhaseBar` export'u kalır (geriye uyum/test) ama App onu kullanmaz.

---

## 5. Test Stratejisi

- **`phaseLabel` (saf):** bilinen faz → etiket; bilinmeyen → aynen.
- **`RunningHorse` (ink-testing-library):** ilk render 🐎 içerir (animasyon karesi). (Timer birim testi yerine ilk-kare doğrulanır; interval cleanup manuel/gözlemle.)
- **`ProgressView`:** verilen faz → dostça etiket frame'de (ör. `waves` → "Kodlanıyor…"); 🐎 var.
- **App running-mode:** ProgressView etiketi görünür (mevcut "faz + kartlar" testi dostça-etikete güncellenir); board kartı korunur.
- Regresyon: tüm suite + typecheck + build yeşil; input-mode/splash değişmez.

---

## 6. Açık Noktalar / İleride

- Animasyon hızı (~130ms) ve pist uzunluğu ayarlanabilir.
- 🐎 emoji genişliği bazı terminallerde 2-hücre; hizalama küçük oynayabilir (kabul).
- Fine faz event'leri (council/judge adım-adım) → ileride H3a threading + daha granüler etiket.
- J3: aynı satıra geçen-süre + model + token eklenecek (ProgressView genişler).
