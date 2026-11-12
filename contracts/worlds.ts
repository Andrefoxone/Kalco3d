// Scene (ambienti 3D) con World Labs Marble: opzioni e costi condivisi tra
// server e interfaccia. Motore e chiamate in api/worlds/.

export const WORLD_QUALITIES = ["bozza", "standard", "grande"] as const;
export type WorldQuality = (typeof WORLD_QUALITIES)[number];

export interface WorldQualityInfo {
  id: WorldQuality;
  label: string;
  hint: string;
  /** modello World Labs usato */
  model: "marble-1.0-draft" | "marble-1.1" | "marble-1.1-plus";
  credits: number;
}

/**
 * Crediti di una scena. Regola di Kalco3D: almeno 2× il costo del motore,
 * con il credito al valore più basso (piano Maker, 19 € / 150 ≈ 0,127 €).
 * Costi World Labs (docs.worldlabs.ai/api/pricing, novembre 2026):
 *   bozza    marble-1.0-draft   0,12 $ (+ ~0,08 $ se parte da una foto)
 *   standard marble-1.1         1,20 $ (+ ~0,08 $ da foto)
 *   grande   marble-1.1-plus    1,20–2,40 $ (dimensione decisa dal motore)
 */
export const WORLD_QUALITY_INFO: Record<WorldQuality, WorldQualityInfo> = {
  bozza: { id: "bozza", label: "Bozza", hint: "Prova veloce dell'idea, qualità bassa", model: "marble-1.0-draft", credits: 3 },
  standard: { id: "standard", label: "Standard", hint: "Scena completa, circa 5 minuti", model: "marble-1.1", credits: 20 },
  grande: { id: "grande", label: "Grande", hint: "Il motore allarga la scena dove può", model: "marble-1.1-plus", credits: 38 },
};

export function worldCreditCost(q: WorldQuality): number {
  return WORLD_QUALITY_INFO[q].credits;
}

/** Mesh GLB texturizzata della scena (export HQ di World Labs: 2,80 $). */
export const WORLD_MESH_CREDITS = 42;

/** Scene in lavorazione contemporanee per utente. */
export const MAX_WORLD_JOBS_PER_USER = 2;
