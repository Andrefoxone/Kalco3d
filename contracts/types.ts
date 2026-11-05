export * from "./errors";

export const MODEL_MODES = ["rilievo", "torno", "sfera", "cilindro"] as const;
export type ModelMode = (typeof MODEL_MODES)[number];

export const MODE_LABELS: Record<ModelMode, string> = {
  rilievo: "Rilievo",
  torno: "Torno",
  sfera: "Sfera",
  cilindro: "Cilindro",
};

export const MODE_HINTS: Record<ModelMode, string> = {
  rilievo: "Bassorilievo dalla luminosità; con il ritaglio dello sfondo segue la sagoma dell'oggetto",
  torno: "Vasi, bottiglie e oggetti tondi: cavi all'interno, aperti sopra, con parete e fondo",
  sfera: "La foto avvolge e deforma una sfera",
  cilindro: "Effetto litofania avvolta su un cilindro",
};
