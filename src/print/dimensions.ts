// Misure reali: il modello arriva in unità della scena (Y in alto); in stampa
// tutto si riduce al "lato più lungo" in mm. Qui si passa da una misura nota
// (es. "alta 18 cm") al lato più lungo, e viceversa.
export type Axis = "altezza" | "larghezza" | "profondita" | "lungo";

export interface SceneSize {
  x: number;
  y: number;
  z: number;
}

export interface DimsMm {
  larghezza: number;
  profondita: number;
  altezza: number;
}

function sideOf(size: SceneSize, axis: Axis): number {
  if (axis === "altezza") return size.y;
  if (axis === "larghezza") return size.x;
  if (axis === "profondita") return size.z;
  return Math.max(size.x, size.y, size.z);
}

/** Larghezza × profondità × altezza in mm con il lato più lungo dato. */
export function dimsMm(size: SceneSize, longestMm: number): DimsMm {
  const max = Math.max(size.x, size.y, size.z) || 1;
  const k = longestMm / max;
  return { larghezza: size.x * k, profondita: size.z * k, altezza: size.y * k };
}

/** Lato più lungo che dà alla dimensione scelta il valore voluto. */
export function longestFor(size: SceneSize, axis: Axis, valueMm: number): number {
  const side = sideOf(size, axis);
  const max = Math.max(size.x, size.y, size.z);
  if (!(side > 0) || !(max > 0)) return valueMm;
  return (valueMm * max) / side;
}

/** Valore della dimensione scelta con il lato più lungo dato. */
export function valueFor(size: SceneSize, axis: Axis, longestMm: number): number {
  const max = Math.max(size.x, size.y, size.z) || 1;
  return (sideOf(size, axis) * longestMm) / max;
}

export function fmtMm(mm: number): string {
  return mm >= 100 ? String(Math.round(mm)) : mm.toFixed(1).replace(".", ",").replace(/,0$/, "");
}
