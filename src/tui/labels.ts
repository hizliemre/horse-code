// İçsel faz adı → Türkçe dostça etiket.
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

export function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? phase;
}
