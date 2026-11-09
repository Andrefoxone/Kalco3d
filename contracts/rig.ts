// Auto-rigging e animazioni: opzioni condivise tra server e interfaccia.
// Motore: Tripo (rig-check → rig → retarget), vedi api/ai3d/rig.ts.

/** Scheletro compatibile con… (vale solo per i personaggi a due gambe). */
export const RIG_SPECS = [
  { id: "tripo", label: "Standard", hint: "Va bene per web, Blender e la maggior parte dei programmi" },
  { id: "mixamo", label: "Mixamo", hint: "Nomi delle ossa Mixamo: riusi le animazioni di Mixamo" },
  { id: "unreal", label: "Unreal", hint: "Scheletro compatibile con il manichino di Unreal Engine" },
  { id: "unity", label: "Unity", hint: "Pronto per l'Humanoid di Unity" },
] as const;
export type RigSpec = (typeof RIG_SPECS)[number]["id"];

/** Animazioni pronte per i personaggi a due gambe (preset Tripo rig v3). */
export const BIPED_ANIMATIONS = [
  { id: "preset:idle", label: "Fermo" },
  { id: "preset:walk", label: "Cammina" },
  { id: "preset:run", label: "Corre" },
  { id: "preset:jump", label: "Salta" },
  { id: "preset:turn", label: "Si gira" },
  { id: "preset:climb", label: "Si arrampica" },
  { id: "preset:dive", label: "Si tuffa" },
  { id: "preset:slash", label: "Colpo di spada" },
  { id: "preset:shoot", label: "Spara" },
  { id: "preset:hurt", label: "Colpito" },
  { id: "preset:fall", label: "Cade" },
] as const;
export type BipedAnimation = (typeof BIPED_ANIMATIONS)[number]["id"];

/** Tipi di scheletro che il motore riconosce da solo. */
export const RIG_TYPES = ["biped", "quadruped", "hexapod", "octopod", "avian", "serpentine", "aquatic", "others"] as const;
export type RigType = (typeof RIG_TYPES)[number];

export const RIG_TYPE_LABEL: Record<RigType, string> = {
  biped: "personaggio a due gambe",
  quadruped: "animale a quattro zampe",
  hexapod: "creatura a sei zampe",
  octopod: "creatura a otto zampe",
  avian: "uccello",
  serpentine: "serpente",
  aquatic: "creatura acquatica",
  others: "altra forma",
};

/** Per i non bipedi il motore ha una sola animazione di movimento. */
export const CREATURE_ANIMATION: Partial<Record<RigType, string>> = {
  quadruped: "preset:quadruped:walk",
  hexapod: "preset:hexapod:walk",
  octopod: "preset:octopod:walk",
  serpentine: "preset:serpentine:march",
  aquatic: "preset:aquatic:march",
};

export const MAX_ANIMATIONS = 5;

/**
 * Crediti di un rig con animazioni. Costo del motore ≈ 25 crediti Tripo per il
 * rig + 10 per ogni esportazione animata (GLB, e FBX se richiesto): ~0,45 $.
 * Regola: almeno 2× il costo del motore.
 */
export function rigCreditCost(fbx: boolean): number {
  return fbx ? 10 : 8;
}

/** Nome leggibile di un'animazione (anche dal nome della clip nel GLB). */
export function animationLabel(id: string): string {
  const clean = id.replace(/^preset:/, "").toLowerCase();
  const found = BIPED_ANIMATIONS.find((a) => a.id.replace(/^preset:/, "") === clean);
  if (found) return found.label;
  if (/walk|march/.test(clean)) return "Cammina";
  return id;
}
