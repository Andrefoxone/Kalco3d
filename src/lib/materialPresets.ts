// Preset CMF (colore-materiale-finitura) condivisi tra il pannello Stile e le
// varianti colore/materiale del pannello Varianti.
import type { MaterialStyle } from "@/three/scene";

export interface MaterialPreset {
  id: string;
  label: string;
  /** anteprima CSS del campione (colore o gradiente) */
  swatch: string;
  style: MaterialStyle;
}

export const MATERIAL_PRESETS: MaterialPreset[] = [
  {
    id: "foto",
    label: "Foto",
    swatch: "linear-gradient(135deg,#8a8a93,#e0e0e4)",
    // materiale originale del file: texture e mappe PBR del motore AI intatte
    style: { tint: null, useMap: true, metalness: 0.02, roughness: 0.85, original: true },
  },
  {
    id: "marmo",
    label: "Marmo",
    swatch: "#f2f2f0",
    style: { tint: "#f2f2f0", useMap: false, metalness: 0.05, roughness: 0.55 },
  },
  {
    id: "ceramica",
    label: "Ceramica",
    swatch: "linear-gradient(135deg,#faf7f1,#e5ded2)",
    style: { tint: "#f5f2ea", useMap: false, metalness: 0, roughness: 0.32, clearcoat: 0.65 },
  },
  {
    id: "terracotta",
    label: "Terracotta",
    swatch: "#c06a45",
    style: { tint: "#c06a45", useMap: false, metalness: 0, roughness: 0.72 },
  },
  {
    id: "grafite",
    label: "Grafite",
    swatch: "#2a2a2e",
    style: { tint: "#2a2a2e", useMap: false, metalness: 0.15, roughness: 0.6 },
  },
  {
    id: "arancio",
    label: "Arancio",
    swatch: "#ff670d",
    style: { tint: "#ff670d", useMap: false, metalness: 0.1, roughness: 0.5 },
  },
  {
    id: "plastica",
    label: "Plastica",
    swatch: "linear-gradient(135deg,#2f6fed,#7aa7ff)",
    style: { tint: "#2f6fed", useMap: false, metalness: 0, roughness: 0.38, clearcoat: 0.4 },
  },
  {
    id: "gomma",
    label: "Gomma",
    swatch: "#1b1b1e",
    style: { tint: "#1b1b1e", useMap: false, metalness: 0, roughness: 0.95 },
  },
  {
    id: "legno-chiaro",
    label: "Legno chiaro",
    swatch: "linear-gradient(135deg,#c79a63,#a87c49)",
    style: { tint: "#bd9260", useMap: false, metalness: 0, roughness: 0.68 },
  },
  {
    id: "legno-scuro",
    label: "Legno scuro",
    swatch: "linear-gradient(135deg,#6f4b2c,#4a3018)",
    style: { tint: "#5f4128", useMap: false, metalness: 0, roughness: 0.6 },
  },
  {
    id: "metallo",
    label: "Metallo",
    swatch: "linear-gradient(135deg,#9a9aa2,#e8e8ee)",
    style: { tint: "#c8c8cc", useMap: false, metalness: 1, roughness: 0.28 },
  },
  {
    id: "cromo",
    label: "Cromo",
    swatch: "linear-gradient(135deg,#f4f6f8,#9fb0bd)",
    style: { tint: "#eef1f4", useMap: false, metalness: 1, roughness: 0.06 },
  },
  {
    id: "rame",
    label: "Rame",
    swatch: "linear-gradient(135deg,#c9804a,#8f4f24)",
    style: { tint: "#b87345", useMap: false, metalness: 1, roughness: 0.3 },
  },
  {
    id: "ottone",
    label: "Ottone",
    swatch: "linear-gradient(135deg,#d9b45c,#9a7a2e)",
    style: { tint: "#c9a44e", useMap: false, metalness: 1, roughness: 0.35 },
  },
  {
    id: "oro",
    label: "Oro",
    swatch: "linear-gradient(135deg,#a87f23,#f0d98a)",
    style: { tint: "#d4af37", useMap: false, metalness: 1, roughness: 0.32 },
  },
  {
    id: "vetro",
    label: "Vetro",
    swatch: "linear-gradient(135deg,#e9f3f6,#bcd6dd)",
    style: { tint: "#eaf4f6", useMap: false, metalness: 0, roughness: 0.05, transmission: 1 },
  },
];

export function findPresetId(m: MaterialStyle): string {
  return (
    MATERIAL_PRESETS.find(
      (p) =>
        p.style.tint === m.tint &&
        p.style.useMap === m.useMap &&
        (p.style.transmission ?? 0) === (m.transmission ?? 0),
    )?.id ?? "custom"
  );
}
