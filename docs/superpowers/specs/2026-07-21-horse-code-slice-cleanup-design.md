# horse-code Dilim CLEANUP — Ertelenen Notlar Kapanışı Tasarım Dokümanı

**Tarih:** 2026-07-21
**Durum:** Onaylandı, plana hazır
**Kapsam:** Ertelenen backlog'un gerçek+erişilebilir fix'lerini kapat; kalanını ledger'da gerekçeyle kapat.

---

## 1. Amaç ve Kapsam

Final-review triage'da biriken ertelenen notların **gerçek robustluk değeri olan, erişilebilir, self-contained** olanlarını çöz. Geri kalanı (zaten-kapanmış / latent / kozmetik / kasıtlı) ledger'da resmen kapatılır (kod değişikliği yok).

**3 fix:**
1. **commitMerge nothing-to-commit guard** — no-değişiklik dalga/revision → `git commit` throw'unu önle.
2. **nodeLineReader piped-race** — buffered-line-queue → non-interactive çoklu-soru cevap kaybını gider.
3. **revision card-id namespace** — `"revision"` → `"__revision__"` (kullanıcı task'ı "revision" ile collision'ı önle).

### Ledger'da kapatılacak (kod değişikliği YOK)
- **Zaten kapanmış:** TUI çift-`>`, spec/plan clobber (.hc/), session-leak, prDiff-cap, onayla-regex (F2 word-boundary), write/edit workdir-guard (H1), runToCompletion round-cap (`maxTurns 50`), read_file guard-mesaj-formatı (zaten `issues.map`).
- **Latent (erişilemez):** E4-M2 rounds-clamp (wiring rounds hep 3), E4b/c derin conflict edge'leri.
- **Kozmetik/rapor/kapsam:** E4-M1 abandon-kolonu (Board'da FAILED kolon yok — büyük tip değişikliği, stageHistory abandon'u kaydediyor), CRLF/truncation/coverage notları, boilerplate-dup, hand-declared tipler, broad-catch (kasıtlı).

---

## 2. Fix #1 — `commitMerge` nothing-to-commit guard (`src/worktree/manager.ts`)

**Mevcut:**
```typescript
async commitMerge(session: WorktreeSession, message?: string): Promise<void> {
  await this.run(["add", "-A"], session.baseWorktree);
  await this.run(message ? ["commit", "-m", message] : ["commit", "--no-edit"], session.baseWorktree);
}
```

**Yeni:**
```typescript
async commitMerge(session: WorktreeSession, message?: string): Promise<void> {
  await this.run(["add", "-A"], session.baseWorktree);
  const staged = await this.git(["diff", "--cached", "--quiet"], session.baseWorktree);
  if (staged.code === 0) return; // sahnede değişiklik yok → commit'i atla (throw önlenir)
  await this.run(message ? ["commit", "-m", message] : ["commit", "--no-edit"], session.baseWorktree);
}
```

- `git diff --cached --quiet` → exit 0 = sahne boş, exit 1 = değişiklik var (`this.git` non-throwing `{code}`).
- No-değişiklik revision turu (senior hiçbir şey değiştirmezse) veya boş dalga → sessizce no-op (job hata vermez).
- Değişiklik varsa mevcut davranış (commit) aynen.

---

## 3. Fix #2 — `nodeLineReader` piped-race (`src/terminal.ts`)

**Sorun (I1 deferred):** `readline/promises` `question()` ardışık çağrılırken, tüm piped input + EOF event-loop yield'inden önce gelince ikinci `question()` cevabı kaçırır (interaktif TTY etkilenmez; pipe/CI çoklu-soru etkilenir).

**Çözüm:** `question()` yerine `on("line")` buffered-queue; injectable stream'lerle test edilebilir.

```typescript
export function nodeLineReader(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): { read: LineReader; close: () => void } {
  const rl = createInterface({ input, output });
  const buffered: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let closed = false;
  rl.on("line", (line) => {
    const w = waiters.shift();
    if (w) w(line);
    else buffered.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()!(""); // kalan bekleyenlere boş cevap
  });
  const read: LineReader = (prompt) => {
    output.write(prompt + "\n> ");
    if (buffered.length) return Promise.resolve(buffered.shift()!);
    if (closed) return Promise.resolve("");
    return new Promise<string>((resolve) => { waiters.push(resolve); });
  };
  return { read, close: () => rl.close() };
}
```

- Satır'lar `buffered`'a kuyruklanır; okuma kuyruktan çeker veya bekler → **race yok** (event'ler senkron kuyruklanır).
- Caret (`\n> `) korunur (manuel `output.write`); interaktif echo `output=stdout` ile korunur.
- `input`/`output` inject edilebilir → PassThrough ile test.
- cli çağrısı `nodeLineReader()` (argümansız → default stdin/stdout) değişmez.

---

## 4. Fix #3 — revision card-id namespace (`src/engine/revision.ts`)

**Sorun:** `board.addCard({ id: "revision", ... })` — PM board'unda kullanıcı task'ı slug'ı "revision" olursa `addCard` "kart zaten var" throw eder (loud-fail, side-effect öncesi güvenli ama iş çöker).

**Çözüm:** card id'yi task-slug'larıyla çakışmayacak sentinel'e çevir: `"revision"` → `"__revision__"`. `revision.ts`'teki TÜM `"revision"` referansları (addCard + 5 appendStage) güncellenir.

- PM task id'leri `toSlug` çıktısı (harf/rakam/tire) → `__revision__` üretemez → collision imkânsız.

---

## 5. Test Stratejisi

- **Fix #1:** `WorktreeManager.commitMerge` — sahne boşken (değişiklik yok) throw etmez + commit oluşturmaz; değişiklik varken commit oluşur. Inject `runGit` fake ile `diff --cached --quiet` code 0/1 dallarını doğrula, veya gerçek repo ile (no-change → no-op).
- **Fix #2:** `nodeLineReader(input, output)` PassThrough ile: tüm input+end ÖNCE verilip iki ardışık `read()` iki satırı da döndürür (race regresyonu); EOF sonrası `read()` boş döner.
- **Fix #3:** revision entegrasyon testi hâlâ geçer (id değişimi); mevcut revision.test `__revision__` id'sini kullanır (ya da id'ye bakmıyorsa değişmez).
- Regresyon: tüm suite + typecheck yeşil.

---

## 6. Açık Noktalar / İleride

- `nodeLineReader` echo davranışı interaktif TTY'de `question()` ile eşdeğer (manuel prompt + readline satır-echo); gerçek TTY manuel doğrulanır.
- E4-M1 abandon terminal-kolon (FAILED/BLOCKED) → Board tip genişletmesi gerektirir; ileride ayrı dilim.
- Kalan ~30 not ledger'da "kapandı" gerekçeleriyle işaretlenir (bu dilimin son adımı).
