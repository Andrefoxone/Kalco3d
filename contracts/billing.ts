// Piani, crediti e costi delle azioni: condivisi tra server e interfaccia.
// I prezzi sono quelli del documento "Kalco3D — costi, crediti e prezzi";
// i prezzi veri li incassa Stripe (un Price per piano, vedi .env.example).

export const SIGNUP_BONUS = 20;
/** generazioni AI contemporanee per utente */
export const MAX_JOBS_PER_USER = 2;

export const PLAN_IDS = ["maker", "pro", "studio"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanInfo {
  id: PlanId;
  name: string;
  /** prezzo mensile IVA inclusa, in euro (solo per mostrarlo) */
  priceEur: number;
  credits: number;
  perks: string[];
}

export const PLANS: PlanInfo[] = [
  { id: "maker", name: "Maker", priceEur: 19, credits: 150, perks: ["≈ 19 modelli standard", "Stampa 3D a colori", "Tutti i formati"] },
  { id: "pro", name: "Pro", priceEur: 49, credits: 450, perks: ["≈ 56 modelli standard", "Qualità Pro e più viste", "Uso commerciale"] },
  { id: "studio", name: "Studio", priceEur: 119, credits: 1300, perks: ["≈ 162 modelli standard", "Tutto di Pro", "Supporto dedicato"] },
];

export const PACK = { id: "pack" as const, name: "Ricarica", priceEur: 15, credits: 100 };

export function planById(id: string): PlanInfo | undefined {
  return PLANS.find((p) => p.id === id);
}

/**
 * Crediti di una generazione AI. Regola: almeno 2× il costo del motore.
 * Stampa = solo forma (il motore costa la metà).
 */
export function creditCost(quality: "bozza" | "standard" | "pro", target: "ecommerce" | "stampa" | "render" | "gioco"): number {
  if (quality === "bozza") return 5;
  if (quality === "pro") return 15;
  return target === "stampa" ? 5 : 8;
}
