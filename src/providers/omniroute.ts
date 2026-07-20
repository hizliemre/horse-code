/**
 * omniroute'un TUTARSIZ hata gövdesini tek mesaja indirger:
 *  - 401: { "error": "<string>" }
 *  - diğer: { "error": { "message": "..." } }
 *  - JSON değilse / uygun alan yoksa: "omniroute <status>"
 */
export async function readErrorMessage(res: Response): Promise<string> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return `omniroute ${res.status}`;
  }
  const err = (body as { error?: unknown }).error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return `omniroute ${res.status}`;
}
