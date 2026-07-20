# horse-code Dilim E0 — Structured Role Output Tasarım Dokümanı

**Tarih:** 2026-07-20
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md`

---

## 1. Amaç ve Kapsam

Bir role-agent'ın **şema-doğrulamalı yapılandırılmış çıktı** üretmesini sağlamak (C spec'inde
ertelenmişti). E2'nin project-manager'ı (task listesi), team-lead'i (bağımlılık grafiği/dalgalar),
E3'ün code-reviewer'ı (verdikt), F'nin refiner'ı (`{refinedPrompt, intent}`) ve judge'u (karar)
hepsi buna bağlı.

**Mekanizma (onaylandı): sentetik `submit` tool.** Role'e, parametreleri = istenen zod şeması olan
bir `submit` tool'u verilir. Model (kendi tool'larıyla bilgi topladıktan sonra) `submit`'i çağırıp
sonucu gönderir; loop args'ı doğrulayıp yakalar. Geçersizse tool `isError` döner → model düzeltir
(kendini düzelten). Tool-calling her modelde sağlam; mevcut C loop'unu yeniden kullanır.

**Tüketir (tamam):** C — `runRoleAgent` (`src/agent/loop.js`), `RoleAgentOptions`; B2 —
`ToolRegistry`, `Tool` (`src/tools/registry.js`, `src/core/types.js`); `zod`.

---

## 2. Arayüz

```typescript
export interface SubmitToolHandle<T> {
  tool: Tool;                              // registry'ye eklenecek "submit" tool'u
  result(): { value: T } | undefined;      // kutu; geçerli submit'e kadar undefined
}

export function buildSubmitTool<T>(schema: z.ZodType<T>): SubmitToolHandle<T>;

export function runStructuredRole<T>(
  opts: RoleAgentOptions,                  // C ile aynı; opts.tools = role'ün ToolRegistry'si
  schema: z.ZodType<T>,                    // zod OBJESİ (yapılandırılmış çıktı = nesne)
): Promise<T>;
```

---

## 3. Davranış

### 3.1 `buildSubmitTool(schema)`

`submit` tool'unu ve bir "kutu" yakalayıcı döner:
- `name: "submit"`, `permissionLevel: "safe"`, `description`: "İşin bittiğinde sonucunu bu araçla
  yapılandırılmış olarak gönder.", `parameters: schema`.
- `run(rawArgs)`: `schema.safeParse(rawArgs)` →
  - **geçerli:** `box = { value: parsed.data }`; `{ content: "alındı", isError: false }`.
  - **geçersiz:** yakalama YOK; `{ content: "submit: geçersiz çıktı: <issues>", isError: true }`.
- `result()`: kutuyu döner (`undefined` = henüz geçerli submit yok). Kutu kullanımı, `T`'nin falsy
  bir değer olabilme ihtimalini (ör. sayı/bool) düzgün ele alır — `!== undefined` yerine kutu varlığı.

### 3.2 `runStructuredRole(opts, schema)`

```
handle = buildSubmitTool(schema)
registry = yeni ToolRegistry; opts.tools'un tüm tool'ları + handle.tool
for await (ev of runRoleAgent({ ...opts, tools: registry })):
    ev.type === "error" → throw Error(ev.message)
    handle.result() varsa → break            // geçerli submit yakalandı, erken çık (fazladan turn yok)
r = handle.result()
r yoksa → throw "structured role: submit çağrılmadı"
return r.value
```

- **Kendini düzelten retry:** geçersiz submit → `isError` tool-result → model bir sonraki turn'de
  düzeltir. C loop'unun `maxTurns`'ü kaçak döngüyü sınırlar.
- **Erken çıkış:** `submit` safe → executeToolCalls'da otomatik/paralel çalışır; `run` kutuya
  yazınca sonraki `handle.result()` kontrolü `break`'ler — provider'a fazladan turn atılmaz.
- **Araç + çıktı bir arada:** role kendi tool'larını (read/grep) kullanıp sonra `submit`
  çağırabilir (ör. code-reviewer önce kodu okur, sonra verdikt'i submit eder). `submit` role'ün
  tool listesine EKlenir, onları değiştirmez.
- **Sadece C'yi kompoze eder:** runStructuredRole runRoleAgent'ı sarar; C loop'una dokunmaz.

---

## 4. Test Stratejisi

`MockProvider` (C'den) `submit` tool-call'ları scriptleyerek deterministik test:

- **buildSubmitTool (saf):** geçerli args → `run` isError:false + `result()` kutusu dolu; geçersiz
  args → isError:true + `result()` undefined; `name`/`permissionLevel`/`parameters` doğru.
- **runStructuredRole:**
  - geçerli submit → parse edilmiş nesneyi döner; istekteki `tools` "submit"'i içerir.
  - geçersiz-sonra-geçerli (turn1 bogus → isError, turn2 geçerli) → doğru sonucu döner; 2 provider isteği.
  - submit hiç çağrılmadı (yalnız metin) → hata fırlatır.
  - provider error → hata fırlatır.
- Tümü `vitest`, TDD, MockProvider ile ağsız.

---

## 5. E0 DIŞI (bilinçli ertelenen)

- **response_format / native JSON mode** — bu mekanizma yerine sentetik submit tool kullanılır.
- **Şema-olmayan çıktı** (düz metin) — zaten `runRoleAgent`/`runToCompletion` (C) verir.
- **Role çözümü** (RoleRegistry.resolve ile role adından) — çağıran (E2/F) `resolve` + `runStructuredRole`'ü kompoze eder; E0 yalnızca `opts`+`schema` alır.
- **submit çağrılmadığında nudge-retry** (E0: doğrudan hata) → gerekirse ileride.
- **Skill enjeksiyonu** (E-skills) — ayrı alt-dilim.

---

## 6. Açık Noktalar / İleride

- `schema` bir zod **objesi** olmalı (tool parametreleri nesne bekler). Non-obje şema → JSON Schema
  çıktısı OpenAI tool-params ile uyumsuz olabilir; kullanım bunu varsayar (plan doğrular).
- Aynı turn'de `submit` + başka tool çağrılırsa: `submit` yakalanınca break edilir; diğer tool
  sonuçları hesaplanır ama geri beslenmez (yapılandırılmış çıktı zaten alınmış) — kabul edilebilir.
