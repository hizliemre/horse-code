# horse-code Dilim HARDENING — Ertelenen Notlar Tasarım Dokümanı

**Tarih:** 2026-07-21
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md`
**Kapsam:** Mekanizma tamam; final-review triage'da biriken 4 yüksek-değerli ertelenen not kapatılır.

---

## 1. Amaç ve Kapsam

Mekanizma uçtan uca çalışıyor (330 test). Bu dilim, gerçek uçtan-uca kullanımda ısıracak 4 **robustluk/güvenlik/UX** açığını kapatır. Kozmetik/test-kapsamı notları ertelemede kalır.

**4 fix (birbirinden bağımsız, tek dilim):**
1. **spec/plan repo-dosyası ezme** → committed `.hc/` dizinine taşı.
2. **prDiff size-cap** → `manager.diff()` çıktısını sınırla (büyük PR context taşması).
3. **TUI çift-`>`** → caret'i `nodeLineReader`'a taşı; seam'ler ham soru üretir.
4. **Session leak** → `runJob`'ı try/catch'e al; beklenmedik throw'da worktree'yi temizle.

### Kapsam DIŞI (ertelemede kalır)
- B2 tool kozmetikleri (CRLF, truncation-testsiz, guard-mesaj-formatı), config cast'leri, E4 board-persist hardening (engine board save/load kullanmıyor → latent), G1 #2/#4 (namespace/maxRounds), diğer test-kapsamı notları.

---

## 2. Fix #1 — spec/plan → `.hc/` (repo-dosyası ezme)

**Sorun:** `upstream.ts` düz `"spec.md"`/`"plan.md"` yazar; izole worktree'de olsa da, gerçek repoda bu isimde **tracked** dosya varsa `commitMerge`'ün `git add -A`'i onu ezip PR diff'ine kirlilik/veri-kaybı olarak sokar.

**Neden `.horsecode/` değil:** `.horsecode/` **gitignore'da** → oraya yazılan spec/plan `git add -A` ile commit'lenmez → **PR'a girmez** (H1 Arch B'nin amacı: design PR'da görünsün). Bu yüzden **committed, ayırt edici, çakışmayan** bir yol gerekir.

**Karar:** `.hc/spec.md` + `.hc/plan.md`.
- Ayırt edici (çakışma ~0), gitignore'da değil → `commitMerge` PR'a alır, repo-kökü temiz.
- `write_file` zaten `mkdir(dirname, {recursive:true})` yapıyor (write.ts:32) → `.hc/` otomatik oluşur; H1 workdir-guard içinde (cwd-altı).

**Değişiklikler:**
- `src/engine/upstream.ts`: `specPath = ".hc/spec.md"`, `planPath = ".hc/plan.md"`. `existsSync(join(workdir, specPath/planPath))` guard'ları aynen (yol değişkeni üzerinden). `UpstreamResult.approved` bu path'leri döndürür → PM/coach threading değişmez.
- `test/engine/job.test.ts`: done testinde `existsSync(join(res.session.baseWorktree, ".hc/spec.md"))` + `.hc/plan.md`.

---

## 3. Fix #2 — prDiff size-cap

**Sorun:** `manager.diff(session, base)` tam unified diff'i sınırsız döndürür; büyük PR → `runRevision` prompt'unu şişirir, context taşması/maliyet.

**Karar:** `diff()` çıktısını `MAX_DIFF_CHARS` (60_000) ile kes; kesildiğinde sona insan-okunur not ekle.

**Değişiklikler:**
- `src/worktree/manager.ts`: `diff()` içinde
  ```
  const out = r.stdout;
  if (out.length <= MAX_DIFF_CHARS) return out;
  return out.slice(0, MAX_DIFF_CHARS) + `\n… (diff kısaltıldı: ${out.length - MAX_DIFF_CHARS} karakter atlandı)`;
  ```
  `const MAX_DIFF_CHARS = 60_000;` (modül-üstü sabit).
- Test: uzun stdout üreten fake git → dönüş `MAX_DIFF_CHARS + not` uzunluğunda, kesme-notu içerir; kısa diff aynen döner.

---

## 4. Fix #3 — TUI çift-`>` (seam prompt sunumu)

**Sorun:** `makeAskUser`/`makeApprove`/`makeAskHuman` readline caret'ini (`\n> ` / ` > `) prompt string'e gömer. TUI'de bu string `Prompt`'un soru `Text`'i olarak render olur, `Prompt` kendi `> {buf}` caret'ini de ekler → çift `>`.

**Karar:** Caret bir **reader-sunum** işi → `nodeLineReader`'a taşı. Seam-builder'lar **ham soru** üretir (caret yok). `controller.ask` (TUI) değişmez (`Prompt` kendi caret'ini çizer).

**Değişiklikler (`src/terminal.ts`):**
- `makeAskUser`: `read(\n[soru] ${question})` (sondaki `\n> ` kaldırıldı).
- `makeApprove`: `read(\n[izin] ${req.preview}\nonayla? (e/h))` (sondaki ` > ` kaldırıldı).
- `makeAskHuman`: `read(\n[insan] task "${ctx.card.title}" — ${notes}\n(accept / retry: <not> / abandon))` (sondaki ` > ` kaldırıldı).
- `nodeLineReader`: `read: (prompt) => rl.question(prompt + "\n> ")` (caret terminal'de eklenir).
- Sonuç: readline tek `> ` caret gösterir; TUI tek `> ` (Prompt'tan). Parse mantığı (`e/h`, `accept/retry/abandon`) değişmez (cevap üzerinde çalışır).

**Test (`test/terminal.test.ts`):** mevcut `toContain("X mi?")` vb. korunur; ek: seam prompt'u sonda `> ` caret **içermez** (ham soru); `nodeLineReader`(inject edilmiş fake rl) prompt'u `\n> ` ile biter.

---

## 5. Fix #4 — Session leak (throw'da orphan worktree)

**Sorun:** `runJob` gövdesi try/finally'siz. `chat`/`rejected` `closeSession` yapar; `done` worktree'yi **bilinçli korur** (deliverable/PR için). Ama `runWaves`/`runRevision`/`runCoachReport` **beklenmedik throw** ederse `session` orphan kalır (`.worktrees/<slug>` diskte birikir).

**Neden "her zaman temizle" DEĞİL:** `closeSession` `hc/<slug>/*` branch'lerini `git branch -D` ile siler. PR stub (H2 logPRAdapter) veya push başarısızsa, tamamlanmış iş **yalnız o lokal branch'te** olabilir → agresif temizlik veri kaybı. Bu yüzden **başarıda koru, yalnız hata-yolunda temizle.**

**Karar:** `runJob` gövdesini `try`'a al; `catch`'te `await deps.manager.closeSession(session).catch(() => {})` (temizlik hatası orijinal hatayı gölgelemesin) + `throw e`. Başarı/chat/rejected yolları aynen (davranış değişmez).

**Değişiklikler (`src/engine/job.ts`):**
```
const session = await deps.manager.openSession(...);
try {
  ... mevcut gövde (chat/rejected close'ları + done return dahil) ...
} catch (e) {
  await deps.manager.closeSession(session).catch(() => {}); // orphan worktree temizle
  throw e;
}
```
**Test:** `runWaves` (veya bir alt-adım) throw edecek şekilde ayarlanmış deps → `runJob` reject eder **ve** `closeSession` çağrılır (manager spy / worktree dizini silinmiş). Başarı yolunda `closeSession` çağrılmaz (done worktree korunur — mevcut done testi doğrular).

---

## 6. Test Stratejisi

- Fix #1: mevcut done testi `.hc/` path'ine güncellenir (spec/plan committed worktree'de var).
- Fix #2: `diff()` truncation birim testi (uzun/kısa).
- Fix #3: seam prompt caret-yok assert'leri; nodeLineReader caret-ekler (inject fake).
- Fix #4: throw-path'te closeSession çağrılır; başarı yolunda çağrılmaz.
- Regresyon: tüm suite (330 → ~334) + typecheck + build yeşil.

---

## 7. Açık Noktalar / İleride

- `.hc/` kullanıcı repolarında nadiren gitignore'lanabilir; ana repo-köküne ekstra committed dosya PR'da görünür (Arch B kararı: design PR'da olsun — istenen).
- `MAX_DIFF_CHARS=60_000` kaba; ileride token-tabanlı/öz­et­leyici olabilir (ertelenen G2 #1 tam çözümü).
- Session accumulation-on-success (başarılı her job `.worktrees/<slug>` bırakır) kasıtlı (deliverable) → ileride `hcode --gc` / merge-sonrası temizlik ayrı iş.
- Diğer ~35 ertelenen not (kozmetik/test-kapsamı) ledger'da kayıtlı; talep gelince ele alınır.
