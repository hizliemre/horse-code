# horse-code Dilim H2 — CLI Girişi + Terminal I/O + Provider Wiring Tasarım Dokümanı

**Tarih:** 2026-07-21
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md`
**Üst dilim:** H (TUI/CLI + runJob). H2 = çalışan `hcode` CLI (H1 runJob + gerçek dünya bağlantıları).

---

## 1. Amaç ve Kapsam

`runJob`'u (H1) **gerçek dünyaya** bağlayan CLI: `hcode "<prompt>"` → config yükle →
`OmniRouteProvider` kur → tüm rolleri **varsayılan prompt'larla** çözülebilir yap → gerçek
terminal seam'leri (`askUser`/`askHuman`/`approve`) → `runJob` → sonucu render et. **PRAdapter
stub/log** (PR intent'i loglar; gerçek MCP → G).

**Tüketir (tamam):** H1 `runJob`/`JobDeps`/`JobResult`; Foundation `loadConfig`/`ResolvedConfig`,
`PermissionEngine`; B1 `OmniRouteProvider`; E-skills `SkillRegistry.loadFromDir`; F2
`buildCouncilRegistry`; C `RoleRegistry`; D `WorktreeManager`, `PRAdapter`.

Konum: `src/prompts.ts` (varsayılan prompt'lar), `src/wiring.ts` (buildJobDeps + logPRAdapter),
`src/terminal.ts` (seam'ler), `src/cli.ts` (giriş — `dist/cli.js` = `hcode` bin).

### Kapsam DIŞI (H2 değil)
- **Ink TUI** → H3 (H2 düz terminal render).
- **Gerçek GitHub/Azure MCP PRAdapter** → G (H2 stub/log).
- **revision pipeline** → G.
- **Rafine prompt içerikleri** → G (H2 işlevsel varsayılanlar).
- **Session leak/cleanup, config `escalation.rounds`** (H1 notları) → ileride (H2 rounds varsayılan 3).

---

## 2. `src/prompts.ts` — Varsayılan Rol Prompt'ları

`resolve` out-of-box çalışsın diye her role işlevsel bir varsayılan systemPrompt (2–4 cümle, rol
tablosundaki sorumluluğa göre). Config yalnız model verir; `systemPrompt` verirse ezer.

```typescript
export const REQUIRED_ROLES = [
  "refiner", "coach", "analyst", "planner", "judge", "project-manager", "team-lead",
  "router", "coder", "designer", "senior-coder", "senior-designer", "architect", "code-reviewer",
] as const;
export const DEFAULT_PROMPTS: Record<string, string> = { /* her role için işlevsel prompt */ };
export const DEFAULT_COUNCILORS: CouncilorConfig[] = [
  { name: "security", perspective: "güvenlik açıkları, secret sızıntısı", models: [] },      // models wiring'de config.model ile doldurulur
  { name: "architecture", perspective: "katman ihlali, bağımlılık yönü", models: [] },
  { name: "testability", perspective: "test edilebilirlik, izolasyon", models: [] },
];
```

> Prompt içerikleri **işlevsel** (agent'ın işini yapar); G'de rafine edilir. Örn. refiner:
> "İsteği refine et + intent sınıflandır (chat/feature/bugfix), submit ile döndür."; analyst:
> "Spec yaz; belirsizlikte ask_user ile sor; write_file ile spec dosyasına yaz." vb.

---

## 3. `src/wiring.ts` — `buildJobDeps` + `logPRAdapter`

### 3.1 `buildJobDeps(opts): JobDeps`

`opts = { config: ResolvedConfig; provider: Provider; skillRegistry: SkillRegistry; manager:
WorktreeManager; prAdapter: PRAdapter; askHuman: AskHuman; approve; signal }`. (`askUser`
`JobDeps`'te değil — `runJob` opts'una CLI'de ayrı geçer.)

- **roleRegistry:** her `REQUIRED_ROLES` için `config.roles[name] ?? { models: [config.model] }`
  birleştir → `new RoleRegistry(mergedRoles, DEFAULT_PROMPTS, skillRegistry)`. Böylece her role
  model + (config veya varsayılan) prompt alır; `resolve` hiçbir role'de fırlamaz.
- **councilRegistry/councilors:** `config.council?.councilors ?? DEFAULT_COUNCILORS`; boş `models`
  varsa `config.model` ile doldur → `buildCouncilRegistry(councilors)`.
- **permission:** `new PermissionEngine({ mode: config.mode, allowlist: config.allowlist })`.
- **rounds:** varsayılan `3` (config `escalation.rounds` ileride).
- `provider`/`skillRegistry`/`manager`/`prAdapter`/`approve`/`signal`/`askHuman` doğrudan deps'e geçer.

`JobDeps` alanları: provider, roleRegistry, skillRegistry, permission, approve, signal,
councilRegistry, councilors, manager, prAdapter, rounds, askHuman.

### 3.2 `logPRAdapter(log: (s: string) => void): PRAdapter`

```typescript
createPR(input) => { log(`PR açılacaktı: ${input.branch} → ${input.base} — "${input.title}"`); return { url: "(pending: G — gerçek MCP)" }; }
```

---

## 4. `src/terminal.ts` — Gerçek Terminal Seam'leri

Enjekte edilebilir satır-okuyucu ile (test için fake, üretimde `node:readline/promises`):

```typescript
export type LineReader = (prompt: string) => Promise<string>;

export function makeAskUser(read: LineReader): AskUser;      // (q) => read(q)
export function makeApprove(read: LineReader): (req: PermissionRequest) => Promise<boolean>;
  // req.preview yazdır, "y/e/evet/yes" → true, diğer → false
export function makeAskHuman(read: LineReader): AskHuman;
  // ctx özeti yazdır; satır parse: "accept/kabul"→accept, "retry: <not>"→retry(notes), diğer→abandon
export function nodeLineReader(): LineReader;                // node:readline/promises tabanlı üretim okuyucusu
```

---

## 5. `src/cli.ts` — Giriş

- **`parseArgs(argv: string[]): { prompt: string; fromBranch?: string; jobName?: string; rounds?: number }`**
  (saf, testlenebilir): ilk pozisyonel = prompt; `--branch/-b`, `--job/-j`, `--rounds` flag'leri.
- **`renderResult(res: JobResult): string`** (saf): chat→response; rejected→"`<stage>` onaylanmadı";
  done→coach raporu + `wave.status` + PR url.
- **`main(argv)`** (ince glue): `parseArgs` → `loadConfig({cwd, home, env, readFile: readFileSync-güvenli})`
  → `OmniRouteProvider({baseUrl, apiKey})` → `SkillRegistry` + `loadFromDir(<repo>/.horsecode/skills)`
  (varsa) → `WorktreeManager({repoRoot: cwd})` → seam'ler (`nodeLineReader` → make*; `logPRAdapter(console.log)`)
  → `buildJobDeps(...)` → `fromBranch = flag ?? currentBranch(cwd) ?? "main"`,
  `jobName = flag ?? toSlug(prompt)||"hcode-job"` → `runJob(deps, {...})` → `console.log(renderResult(res))`.
  Üstte `#!/usr/bin/env node` shebang.

---

## 6. Test Stratejisi

Glue-ağır; **testlenebilir birimler ayrılır**, `main()` ince kalır:

- **prompts:** `REQUIRED_ROLES`'ün her biri `DEFAULT_PROMPTS`'ta var ve boş değil; `DEFAULT_COUNCILORS` ≥1.
- **buildJobDeps:** minimal `ResolvedConfig` (yalnız `model`) + fake provider/manager/skillRegistry/seam'ler →
  dönen `JobDeps` ile `roleRegistry.resolve(r)` **her `REQUIRED_ROLES` için fırlamaz**;
  `councilRegistry.resolve(councilor)` çalışır; `permission` config.mode'u yansıtır; config.roles override edilir.
- **logPRAdapter:** `createPR` çağrısı log üretir + url döner.
- **terminal seam'leri (fake reader):** approve "y"→true/"n"→false; askUser passthrough; askHuman
  "accept"→accept, "retry: x"→{retry, notes:["x"]}, "abandon"→abandon.
- **parseArgs:** `["prompt", "--branch", "dev", "--rounds", "2"]` → `{prompt, fromBranch:"dev", rounds:2}`.
- **renderResult:** chat/rejected/done varyantları beklenen metni üretir.

Tümü `vitest`, TDD, ağsız/I/O-suz (fake provider/reader/log). `main()` gerçek I/O — birim test
edilmez; parçaları test edilir (manuel `hcode` ile doğrulanır).

---

## 7. H2 DIŞI (bilinçli ertelenen)

- **Ink TUI** → H3.
- **Gerçek MCP PRAdapter (GitHub/Azure)** → G.
- **Rafine prompt içerikleri, principal-coder** → G.
- **Session leak/cleanup (H1 #1), config escalation.rounds, spec.md/plan.md yol çakışması (H1 #3)** → ileride.

---

## 8. Açık Noktalar / İleride

- `currentBranch(cwd)` git çağrısıyla (rev-parse --abbrev-ref HEAD); detached/hata → "main" fallback.
- `main()` hata yönetimi: runJob throw → stderr + exit 1 (H2 basit; zengin hata H3/G).
- Varsayılan prompt'lar işlevsel ilk hali; kalite G'de artar (council/judge daha titiz olabilir).
- `escalation.rounds` config'e eklenince wiring oradan okur (şimdilik 3).
