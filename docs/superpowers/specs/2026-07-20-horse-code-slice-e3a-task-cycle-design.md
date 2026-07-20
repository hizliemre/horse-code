# horse-code Dilim E3a — Task Cycle Tasarım Dokümanı

**Tarih:** 2026-07-20
**Durum:** Onaylandı, plana hazır
**Üst tasarım:** `2026-07-20-horse-code-multi-agent-orchestration-design.md` (§5.2 akış, §5.5 yeni-vs-dönen)

---

## 1. Amaç ve Kapsam

Bir task'ın **tek-tur yaşam döngüsü**: routing (coder/designer) → implementer'ı izole task
worktree'sinde çalıştır → REVIEW → code-reviewer verdikti → geçer→DONE / kalır→TODO+notlar.
Escalation (coder→senior-coder→konsey) ve worktree oluşturma/merge **E3a DIŞI** (E3b / E4).

**Tüketir (tamam):** C — `RoleAgentOptions`, `runToCompletion` (`src/agent/loop.js`); E0 —
`runStructuredRole` (`src/agent/structured.js`); E1 — `Board`/`Card` (`src/board/board.js`);
E-skills — `RoleRegistry` (skill enjeksiyonlu), `SkillRegistry`, `buildSkillTool`; B2 —
`createDefaultRegistry`/`ToolRegistry` (`src/tools/`); Foundation — `PermissionEngine`,
`Provider`, `zod`.

Konum: `src/engine/` (E2 ile aynı).

---

## 2. Ortak Bağımlılık Paketi

```typescript
export interface TaskCycleDeps {
  provider: Provider;
  roleRegistry: RoleRegistry;                 // skillRegistry ile kurulmuş (zorunlu skill enjeksiyonu)
  skillRegistry: SkillRegistry;               // buildSkillTool için
  permission: PermissionEngine;
  approve: (req: PermissionRequest) => Promise<boolean>;
  signal: AbortSignal;
}

export type ImplementerRole = "coder" | "designer";
export interface Verdict { verdict: "pass" | "fail"; notes: string[] }
```

> **E-skills wiring kuralı (final review notu):** Bir role çalıştırılırken `RoleRegistry.resolve`
> (skillRegistry ile → zorunlu skill + keşif listing prompt'ta) VE toolset'e
> `buildSkillTool(skillRegistry)` **birlikte** eklenir. Prompt "skill tool" vaat ettiğinden, tool
> yoksa model olmayan aracı çağırır. E3a bu ikisini her zaman birlikte wire eder.

---

## 3. Birimler

### 3.1 `routeTask(deps, task: Card): Promise<ImplementerRole>`

- `RoleRegistry.resolve("router")` + `runStructuredRole(opts, RouteSchema)` ile task title'dan
  `{ role: "coder"|"designer" }`. `RouteSchema = z.object({ role: z.enum(["coder","designer"]) })`.
- **Herhangi bir başarısızlık** (tanımsız "router" role, LLM hatası, invalid çıktı) → **`"coder"`
  fallback** (routing pipeline'ı bloklamaz). **İstisna: `signal.aborted` ise hata yukarı fırlar**
  (iptal yutulmaz — E0/E2 dersleri).

### 3.2 `runImplementer(deps, role: ImplementerRole, task: Card, cwd: string): Promise<void>`

- `RoleRegistry.resolve(role)` → `{model, systemPrompt}` (skill'ler enjekte).
- **Worktree-scope'lu toolset:** `createDefaultRegistry()` (read/grep/glob/write/edit/shell/web) +
  `buildSkillTool(deps.skillRegistry)`. Tool'lar `cwd`'ye (task worktree) göre çalışır → değişiklikler
  worktree'ye yazılır.
- **Yeni-vs-dönen mesajı:** `task.reviewNotes.length > 0` → "dönen task, şu notları gider: …";
  boşsa → "yeni task, şunu uygula: …" (task.title). Mesaj `messages`'e konur.
- `runToCompletion({ provider, model, systemPrompt, tools, messages, permission, approve, cwd, signal })`.
  Sonuç side-effect (worktree dosyaları); dönüş `void`.

### 3.3 `runReviewer(deps, task: Card, cwd: string): Promise<Verdict>`

- `RoleRegistry.resolve("code-reviewer")` (skill'ler enjekte).
- **Salt-okunur toolset:** `read/grep/glob` + `buildSkillTool` (write/edit/shell YOK — reviewer
  değiştirmez). Ayrı bir helper ile kurulur (createDefaultRegistry'nin salt-okunur alt-kümesi).
- Mesaj: "task '<title>' için worktree'deki değişiklikleri incele; verdikt ver."
- `runStructuredRole(opts, VerdictSchema)` → `{ verdict, notes }`.
  `VerdictSchema = z.object({ verdict: z.enum(["pass","fail"]), notes: z.array(z.string()) })`.

### 3.4 `runTaskCycle(deps, board: Board, taskId: string, worktreePath: string): Promise<Verdict>`

```
task = board.get(taskId)   (yoksa hata)
role = await routeTask(deps, task)
board.setWorktree(taskId, worktreePath)
board.move(taskId, "IN-PROGRESS", role)
await runImplementer(deps, role, board.get(taskId)!, worktreePath)   // güncel reviewNotes
board.move(taskId, "REVIEW", role)
v = await runReviewer(deps, board.get(taskId)!, worktreePath)
if v.verdict === "pass":
   board.appendStage(taskId, { role: "code-reviewer", action: "reviewed:pass" })
   board.move(taskId, "DONE", "code-reviewer")
else:
   board.appendStage(taskId, { role: "code-reviewer", action: "reviewed:fail", note: v.notes.join("; ") })
   board.clearReviewNotes(taskId)
   for n of v.notes: board.addReviewNote(taskId, n)     // reviewNotes = son turun notları
   board.move(taskId, "TODO", "code-reviewer")
return v
```

- **reviewNotes politikası:** fail'de **clear + set** (coder en güncel geri bildirimi görür); tam
  geçmiş `stageHistory`'de.
- **Commit yok:** E3a yalnızca implement + review + Board geçişleri. **git commit + wave-merge + PR
  → E4.** Reviewer commit'siz worktree dosyalarını read-tool'larla okur.

---

## 4. Test Stratejisi

`MockProvider` (turn'ler global ilerler) + gerçek tmp worktree dizini:

- **routeTask:** router submit `{role:"designer"}` → "designer"; LLM hata/invalid → "coder" fallback; pre-aborted signal → fırlatır.
- **runImplementer:** MockProvider implementer'ı `write_file` çağırıp bitirir → tmp worktree'de dosya yazıldı; `task.reviewNotes` doluysa istekteki mesaj notları içerir (dönen); boşsa "yeni".
- **runReviewer:** reviewer submit `{verdict:"fail", notes:["x"]}` → döner; toolset write/edit/shell İÇERMEZ (salt-okunur doğrula).
- **runTaskCycle:** tek MockProvider'da sıralı turn'ler (router → implementer[write, done] → reviewer[submit]). pass → Board DONE + dosya yazılı + stageHistory reviewed:pass; fail → Board TODO + reviewNotes = notlar + stageHistory reviewed:fail.
- Tümü `vitest`, TDD, ağsız (MockProvider) + gerçek fs (tmp).

---

## 5. E3a DIŞI (bilinçli ertelenen)

- **Escalation merdiveni** (coder N tur → senior-coder → konsey, attempts sayacı) → E3b.
- **Worktree oluşturma/merge/PR** (D) → E4. E3a var olan bir worktree yolu alır.
- **Gerçek coder/designer/reviewer/router prompt içerikleri** → F/G (E3a config/varsayılan prompt'la).
- **Dalgaların paralel yürütülmesi** → E4.
- **Reviewer'ın diff'i görmesi için commit** — E3a commit'siz worktree'yi okur; E4'te commit sonrası akış.

---

## 6. Açık Noktalar / İleride

- "router" role config'te tanımlı değilse routing sessizce coder'a düşer — bu davranış audit'e
  loglanabilir (ileride event).
- Reviewer'ın hangi dosyaları inceleyeceği: worktree'nin tamamı (grep/glob ile keşfeder). Diff-temelli
  odak (yalnızca değişen dosyalar) E4'te commit varsa `git diff` ile netleşir.
- Implementer'ın işini "bitirdi" sinyali: `runToCompletion` (tool-call'suz final mesaj). Kod gerçekten
  yazıldı mı garanti değil (LLM boş dönebilir) — reviewer bunu yakalar (fail verdikt).
