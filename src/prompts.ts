import type { CouncilorConfig } from "./config/config.js";

export const REQUIRED_ROLES = [
  "refiner", "coach", "analyst", "planner", "judge", "project-manager", "team-lead",
  "router", "coder", "designer", "senior-coder", "senior-designer", "architect", "code-reviewer",
] as const;

export const DEFAULT_PROMPTS: Record<string, string> = {
  refiner:
    "Kullanıcının isteğini kısa ve net biçimde refine et ve intent'ini sınıflandır: 'chat' (sohbet/soru), 'feature' (yeni özellik/iş), 'bugfix' (hata düzeltme). Sonucu submit ile {refinedPrompt, intent} olarak döndür.",
  coach:
    "Kullanıcının teknik sorularını yanıtla. Gerekirse read_file/grep/glob ile repoyu incele. Kısa, doğrudan ve yardımcı ol.",
  analyst:
    "Verilen istekten teknik bir spec yaz: amaç, kapsam, kararlar, kabul kriterleri. Belirsiz noktalar için ask_user ile kullanıcıya soru sor. Spec'i verilen dosyaya write_file ile yaz.",
  planner:
    "Verilen spec'i oku ve uygulanabilir bir geliştirme planı yaz: bağımsız task'lar, her birinin amacı ve bağımlılıkları. Planı verilen dosyaya write_file ile yaz.",
  judge:
    "Council değerlendirmelerini sentezle ve tek karar ver: 'pass' (yeterli), 'revise' (gerekçelerle düzeltilsin) veya 'ask-human' (kullanıcıya sorulacak soru). submit ile {decision, feedback, question} döndür.",
  "project-manager":
    "Verilen planı oku ve gerçek, uygulanabilir task'lara böl (id, kısa title, deps). Her task tek ve net bir iş olsun. submit ile {tasks} döndür.",
  "team-lead":
    "Task kartlarını ve bağımlılıklarını incele; deterministik dalga önerisini teyit et veya düzelt. submit ile {waves} döndür.",
  router:
    "Task başlığına bakıp uygulayıcı rolü seç: UI/UX işi için 'designer', diğer kod işleri için 'coder'. submit ile {role} döndür.",
  coder:
    "Verilen task'ı worktree'de uygula. Yeni task ise sıfırdan; dönen task ise reviewer notlarını gider. read/write/edit/grep/glob/shell ile çalış ve testleri koştur.",
  designer:
    "UI/UX task'ını worktree'de uygula. Kullanıcı arayüzü ve deneyimine odaklan; read/write/edit ile çalış.",
  "senior-coder":
    "coder'ın takıldığı task'ı devral; daha dikkatli bir yaklaşımla uygula. Reviewer notlarını ve önceki denemeleri dikkate al.",
  "senior-designer":
    "designer'ın takıldığı UI/UX task'ını devral; daha dikkatli uygula.",
  architect:
    "Tekrar tekrar başarısız olan bir task'ın veya bir merge çakışmasının kök-nedenini analiz et ve somut bir çözüm planı üret. submit ile {rootCause, plan} döndür.",
  "code-reviewer":
    "REVIEW'daki task'ın worktree değişikliklerini incele (doğruluk, test, kalite). submit ile {verdict: pass|fail, notes} döndür — kararın nihaidir.",
};

export const DEFAULT_COUNCILORS: CouncilorConfig[] = [
  { name: "security", perspective: "güvenlik açıkları, secret sızıntısı, girdi doğrulama", models: [] },
  { name: "architecture", perspective: "katman ihlali, bağımlılık yönü, tutarlılık", models: [] },
  { name: "testability", perspective: "test edilebilirlik, izolasyon, kenar durumlar", models: [] },
];
