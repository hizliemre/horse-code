# horse-code Dilim I2 — Local-only Fallback Tasarım Dokümanı

**Tarih:** 2026-07-21
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md`
**Üst dilim:** I (install/init/interactive). I2 = git remote yoksa yerel çalışma.

---

## 1. Amaç ve Kapsam

`hcode`'un **origin remote'u olmayan** bir repoda da çalışmasını sağla: push/PR atlanır, iş yerel `hc/<jobSlug>/base` branch'ine merge edilir, rapor branch adını gösterir. Onboarding'de kullanıcı herhangi bir repoda remote kurmadan deneyebilir.

**Tasarım (Option C — merkezi, imza değişikliği yok):** Akış içine `hasRemote` bayrağı threading YERİNE iki noktada davranışı yerelleştir:
1. `manager.push` — origin remote yoksa **no-op** (throw etmez).
2. `unknown` PR adapter — döndürdüğü url'e **branch adını** koy (rapor netliği).

cli zaten no-origin'de `remoteUrl=""` → `detectPlatform("")="unknown"` → log-stub adapter seçiyor; **cli değişmez**. Engine imzaları/`runJob`/`runWaves` opts **değişmez**.

### Kapsam DIŞI
- **I3:** no-arg TUI REPL.
- Gerçek push başarısızlığı (remote VAR ama erişilemez) → yine throw (Fix #4 temizler); bu bilinçli (gerçek hata gizlenmez).
- Local-only'de ayrı bir "Yerel branch:" rapor etiketi (url'in kendisi `(yerel: <branch>)` taşır → yeterli).

---

## 2. Fix — `manager.push` remote-yoksa no-op (`src/worktree/manager.ts`)

**Mevcut:**
```typescript
async push(session: WorktreeSession, remote = "origin"): Promise<void> {
  await this.run(["push", remote, session.baseBranch], session.baseWorktree);
}
```

**Yeni:**
```typescript
async push(session: WorktreeSession, remote = "origin"): Promise<void> {
  const check = await this.git(["remote", "get-url", remote], session.baseWorktree);
  if (check.code !== 0) return; // remote yok → local-only, push atla
  await this.run(["push", remote, session.baseBranch], session.baseWorktree);
}
```

- `this.git` (GitRunner) nonzero exit'te **throw etmez**, `{code}` döner → `check.code !== 0` = origin tanımsız → sessizce atla.
- Origin VARSA `this.run` push'u yapar (başarısızlıkta throw → gerçek hata yüzeye çıkar; local-only ile karışmaz).
- Hem `wave-engine.ts:111` hem `revision.ts:114` push'ları bu tek guard'dan geçer → ikisi de local-only'de otomatik atlanır (imza/threading gerekmez).

---

## 3. Fix — `unknown` PR adapter url'ine branch (`src/adapters/pr.ts`)

**Mevcut** (unknown dalı `createPR`):
```typescript
opts.log(`PR (bilinmeyen platform): ${input.branch} → ${input.base} — "${input.title}"`);
return { url: "(bilinmeyen platform — PR açılmadı)" };
```

**Yeni:**
```typescript
opts.log(`PR (yerel — remote/platform yok): ${input.branch} → ${input.base} — "${input.title}"`);
return { url: `(yerel: ${input.branch})` };
```

- `renderResult` `PR: ${res.wave.pr.url}` gösterir → local-only'de `PR: (yerel: hc/<jobSlug>/base)` → kullanıcı işin hangi branch'te olduğunu görür.
- github/azure adapter'ları değişmez (gerçek PR url'i).

---

## 4. Davranış Özeti

| Repo durumu | push | PR adapter | Sonuç raporu |
|---|---|---|---|
| origin GitHub | push eder | `gh pr create` | `PR: <github url>` |
| origin Azure | push eder | `az repos pr create` | `PR: <azure url>` |
| origin bare/local (unknown) | push eder | log-stub | `PR: (yerel: hc/<slug>/base)` |
| **origin YOK** | **no-op** | log-stub | `PR: (yerel: hc/<slug>/base)` — iş yerel branch'te |

Wave `completed` statüsü korunur (partial değil); revision döngüsü normal koşar, push'ları no-op olur.

---

## 5. Test Stratejisi

- **`manager.push` no-op:** origin'siz repoda `wm.push(session)` **throw etmez** ve sessiz döner (bare remote yok → hiçbir yere push yok). Origin'li mevcut test (`pr.test.ts:19`) korunur (origin var → push çalışır).
- **unknown adapter url:** `makePRAdapter({platform:"unknown",...}).createPR({branch:"hc/x/base",...})` → `url === "(yerel: hc/x/base)"`; log branch içerir.
- **Entegrasyon (opsiyonel, mevcut kapsar):** origin'siz uçtan uca job → `wave.status==="completed"`, `pr.url` `(yerel: ...)` — mevcut job.test bare-origin ile completed'ı zaten doğruluyor; origin'siz varyant eklenebilir ama pahalı; birim testler yeterli.
- Regresyon: tüm suite + typecheck yeşil (origin'li push/PR yolları değişmez).

---

## 6. Açık Noktalar / İleride

- Local-only'de iş `hc/<slug>/base` branch'inde kalır (checkout edilmez); kullanıcı `git checkout` ile inceler. `hcode` çıktı raporunda branch adı var.
- `manager.push` remote-adı parametrik (`remote="origin"`); guard aynı remote'u kontrol eder → tutarlı.
- Gerçek push başarısızlığı (auth/network, remote VAR) hâlâ throw → Fix #4 worktree'yi temizler (bilinçli: gerçek hata local-only ile karışmaz).
