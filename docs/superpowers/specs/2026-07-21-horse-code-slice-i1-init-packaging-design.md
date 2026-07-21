# horse-code Dilim I1 — init + packaging Tasarım Dokümanı

**Tarih:** 2026-07-21
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md`
**Üst dilim:** I (install/init/interactive) — dağıtım + onboarding. I1 = `hcode init` + global kurulum.

---

## 1. Amaç ve Kapsam

`hcode`'u kurulabilir + onboard-edilebilir yap. Kullanıcı `npm i -g .` (veya `npm link`) ile `hcode`'u global kurar, `hcode init` ile omniroute baseUrl + apiKey verir (`~/.horsecode/config.json`'a yazılır), sonra gerçek LLM ile çalışır.

**I1 kapsamı:**
1. `hcode init` — interaktif kurulum (baseUrl + apiKey sorar, `model` sabit, global config yazar).
2. Arg-routing — `hcode init` subcommand'i mevcut `hcode "<prompt>"` akışından ayır.
3. Packaging — `package.json` `prepare` script → `npm i -g`/`npm link` otomatik build eder.

### Kapsam DIŞI (sonraki alt-dilimler)
- **I2:** remote'suz (local-only) çalışma.
- **I3:** no-arg `hcode` TUI REPL.
- Model/mode/council'ı init'te sormak (model sabit `auto/best-coding`; ileride genişletilebilir).

---

## 2. `hcode init` — Interaktif Kurulum (`src/init.ts`)

Test edilebilirlik için **enjekte IO** (readline/fs global değil):

```typescript
export interface InitIO {
  read: LineReader;                                  // (prompt) => Promise<string>  (src/terminal.ts)
  readFile: (path: string) => string | undefined;    // yoksa/bozuksa undefined
  writeFile: (path: string, content: string) => void; // parent dizini oluşturur (mkdir -p dahil)
  home: string;                                      // process.env.HOME
  log: (s: string) => void;
}

export async function runInit(io: InitIO): Promise<void>;
```

**Davranış:**
- `path = ${io.home}/.horsecode/config.json`.
- `existing` = `io.readFile(path)` → JSON.parse → obje; yoksa/bozuksa `{}` (mevcut alanları korumak için).
- `baseUrl` = `(await io.read("omniroute baseUrl [http://localhost:20128]: ")).trim() || "http://localhost:20128"` (boş → default).
- `apiKey` = `(await io.read("omniroute apiKey (boş=yok): ")).trim()`.
- `config = { ...existing, baseUrl, model: existing.model ?? "auto/best-coding" }`; `apiKey` boş-değilse `config.apiKey = apiKey`, boşsa `delete config.apiKey` (boş = anahtar yok, öncekini temizler).
- `io.writeFile(path, JSON.stringify(config, null, 2) + "\n")`.
- `io.log("config yazıldı: <path> (apiKey: " + (apiKey ? "set" : "yok") + ")")` — **apiKey değeri loglanmaz**.

**Güvenlik:** apiKey **global** config'e yazılır (proje config'i zaten apiKey'i strip ediyor — mevcut katmanlı yükleme davranışı). Log'da anahtar görünmez.

**Merge-koru:** `existing` yayılır → kullanıcının elle eklediği `mode`/`roles`/`council`/`allowlist` alanları korunur; yalnız `baseUrl`/`model`/`apiKey` güncellenir.

---

## 3. Arg-routing (`src/cli.ts` `main`)

`main`'in EN BAŞINA (parseArgs'tan önce), git/config işlemlerinden ÖNCE:

```typescript
export async function main(argv: string[]): Promise<void> {
  if (argv[0] === "init") {
    const { read, close } = nodeLineReader();
    try {
      await runInit({
        read,
        readFile: (p) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } },
        writeFile: (p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); },
        home: process.env.HOME ?? "",
        log: (s) => console.log(s),
      });
    } finally { close(); }
    return;
  }
  // ... mevcut akış (parseArgs, config, job) ...
}
```

`init` git repo gerektirmez → routing en başta, `currentBranch`/`WorktreeManager`/`loadConfig`'ten önce.

---

## 4. Packaging (`package.json`)

- `scripts`'e ekle: `"prepare": "npm run build"`.
  - `npm i -g .` / `npm link` kaynak dizinde `prepare`'i koşar → `dist/cli.js` üretilir → `bin.hcode` çalışır.
  - `bin: { "hcode": "./dist/cli.js" }` zaten var; `dist/cli.js` shebang (`#!/usr/bin/env node`) tsup banner'ından geliyor.
- Yayımlanmış pakette `files:["dist"]` prebuilt dist'i taşır (tüketicide `prepare` koşmaz) — mevcut.

---

## 5. Test Stratejisi

- **`runInit` (birim, enjekte IO):**
  - boş baseUrl → default `http://localhost:20128`; girilen baseUrl → o.
  - apiKey girilince config'e yazılır; boş girilince yazılmaz (ve mevcut apiKey temizlenir).
  - `model` her zaman `auto/best-coding` (existing.model yoksa) veya korunur (varsa).
  - mevcut alanlar (`mode`, `roles`) korunur (merge).
  - `writeFile` doğru path + geçerli JSON ile çağrılır; apiKey **log'da geçmez**.
- **Arg-routing:** `main`'in `init`'i tanıdığı — `runInit` gerçek IO ile bağlı; birim testi yerine **manuel** doğrulanır (`hcode init`). (Routing tek satır; `runInit` mantığı tam test edilir.)
- **Packaging:** manuel — `npm run build` (prepare) çalışır; `npm link` → `hcode init` config yazar.
- Regresyon: tüm suite + typecheck yeşil.

---

## 6. Açık Noktalar / İleride

- `init` mevcut config'i sessiz overwrite-merge eder (onay sormaz) — basit; ileride `--force`/diff gösterimi.
- Model init'te sabit; ileride `hcode init --model` veya gateway'den model listesi çekip seçtirme.
- `hcode` config'siz çalışırsa default `model:"default"` gateway'de hata verir → I3'te "önce `hcode init` çalıştır" uyarısı düşünülebilir (I1'de kapsam dışı).
