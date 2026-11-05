// Apre la finestra dei piani da qualunque punto dell'app (es. crediti finiti).
const EVENT = "kalco:piani";

export function openPlans(reason?: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: reason ?? null }));
}

export function onOpenPlans(fn: (reason: string | null) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<string | null>).detail);
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}

/** Se l'errore è "crediti insufficienti" apre i piani e restituisce true. */
export function handleNoCredits(err: unknown): boolean {
  const code = (err as { data?: { code?: string } } | null)?.data?.code;
  if (code !== "PAYMENT_REQUIRED") return false;
  openPlans(err instanceof Error ? err.message : "Crediti insufficienti.");
  return true;
}
