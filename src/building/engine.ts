// Kalco3D Building: stampa 3D di grande formato (cemento, pellet/bracci robot,
// oppure stampanti normali a pezzi). Dal solido si ricavano gli strati, i
// percorsi (perimetri + zig-zag), gli sbalzi critici, il preventivo e il G-code.
// Tutte le misure sono in millimetri, Z in alto.
import type { CrossSection, Manifold, ManifoldToplevel } from "manifold-3d";

export type MachineKind = "cemento" | "grande" | "pezzi";
export type Infill = "nessuno" | "zigzag";

export interface Machine {
  id: string;
  label: string;
  kind: MachineKind;
  /** volume di stampa utile, mm */
  volume: { x: number; y: number; z: number };
  nozzleMm: number;
  layerMm: number;
  /** numero di perimetri per lato */
  walls: number;
  infill: Infill;
  /** passo dello zig-zag, mm */
  infillSpacingMm: number;
  speedMmS: number;
  travelMmS: number;
  /** sbalzo massimo rispetto alla verticale, gradi */
  maxOverhangDeg: number;
  material: { label: string; densityKgM3: number; costPerKg: number };
  /** costo orario della macchina (ammortamento, energia, operatore), € */
  machineCostH: number;
  /** asse E nel G-code (le pompe del cemento di solito non lo usano) */
  gcodeE: boolean;
}

/** Valori tipici di partenza: ognuno va adattato alla propria macchina e ai propri prezzi. */
export const MACHINES: Machine[] = [
  {
    id: "cemento-portale",
    label: "Cemento · stampante a portale",
    kind: "cemento",
    volume: { x: 12000, y: 12000, z: 3500 },
    nozzleMm: 40,
    layerMm: 15,
    walls: 2,
    infill: "zigzag",
    infillSpacingMm: 300,
    speedMmS: 150,
    travelMmS: 300,
    maxOverhangDeg: 15,
    material: { label: "Malta per stampa 3D", densityKgM3: 2200, costPerKg: 0.15 },
    machineCostH: 60,
    gcodeE: false,
  },
  {
    id: "cemento-gru",
    label: "Cemento · gru / delta",
    kind: "cemento",
    volume: { x: 6000, y: 6000, z: 3000 },
    nozzleMm: 25,
    layerMm: 10,
    walls: 2,
    infill: "zigzag",
    infillSpacingMm: 200,
    speedMmS: 100,
    travelMmS: 200,
    maxOverhangDeg: 15,
    material: { label: "Malta / terra cruda", densityKgM3: 2000, costPerKg: 0.12 },
    machineCostH: 45,
    gcodeE: false,
  },
  {
    id: "pellet-robot",
    label: "Grande formato · pellet o braccio robot",
    kind: "grande",
    volume: { x: 2000, y: 1500, z: 1800 },
    nozzleMm: 8,
    layerMm: 3,
    walls: 2,
    infill: "nessuno",
    infillSpacingMm: 60,
    speedMmS: 60,
    travelMmS: 150,
    maxOverhangDeg: 40,
    material: { label: "Pellet PLA/PETG", densityKgM3: 1250, costPerKg: 4 },
    machineCostH: 25,
    gcodeE: true,
  },
  {
    id: "fdm-pezzi",
    label: "Stampante normale · a pezzi",
    kind: "pezzi",
    volume: { x: 256, y: 256, z: 256 },
    nozzleMm: 0.4,
    layerMm: 0.2,
    walls: 3,
    infill: "zigzag",
    infillSpacingMm: 4,
    speedMmS: 120,
    travelMmS: 250,
    maxOverhangDeg: 50,
    material: { label: "Filamento PLA", densityKgM3: 1240, costPerKg: 20 },
    machineCostH: 1.5,
    gcodeE: true,
  },
];

export function machineById(id: string): Machine {
  return MACHINES.find((m) => m.id === id) ?? MACHINES[0];
}

type Pt = [number, number];

export interface Layer {
  index: number;
  /** quota del centro dello strato */
  z: number;
  section: CrossSection;
  /** perimetri chiusi, dall'esterno verso l'interno */
  perimeters: Pt[][];
  /** tratti di riempimento, in ordine di stampa (polilinee aperte) */
  infill: Pt[][];
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Taglia il solido in strati; con troppi strati se ne prende uno ogni k (solo anteprima/stima). */
export async function sliceLayers(
  solid: Manifold,
  layerMm: number,
  opts: { maxLayers?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ layers: { index: number; z: number; section: CrossSection }[]; step: number; total: number }> {
  const b = solid.boundingBox();
  const total = Math.max(1, Math.floor((b.max[2] - b.min[2]) / layerMm));
  const step = opts.maxLayers && total > opts.maxLayers ? Math.ceil(total / opts.maxLayers) : 1;
  const layers: { index: number; z: number; section: CrossSection }[] = [];
  for (let i = 0; i < total; i += step) {
    const z = b.min[2] + (i + 0.5) * layerMm;
    const section = solid.slice(z);
    if (!section.isEmpty()) layers.push({ index: i, z, section });
    if (i % 20 === 0) {
      opts.onProgress?.(i, total);
      await tick();
    }
  }
  return { layers, step, total };
}

function ringsOf(cs: CrossSection): Pt[][] {
  return cs.toPolygons().map((p) => p.map((v) => [v[0], v[1]] as Pt)).filter((r) => r.length >= 3);
}

/**
 * Zig-zag a 45° (alternato a −45° tra strati) dentro la regione: le linee di
 * scansione vengono tagliate sui contorni (pari/dispari) e unite a serpentina.
 */
export function zigzag(region: CrossSection, spacing: number, angleDeg: number): Pt[][] {
  const rings = ringsOf(region);
  if (!rings.length || spacing <= 0) return [];
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  // ruota in modo che le linee siano orizzontali
  const rot = rings.map((r) => r.map(([x, y]) => [x * c + y * s, -x * s + y * c] as Pt));
  let y0 = Infinity, y1 = -Infinity;
  for (const r of rot) for (const p of r) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const segs: [Pt, Pt][][] = [];
  for (let y = y0 + spacing / 2; y < y1; y += spacing) {
    const xs: number[] = [];
    for (const r of rot) {
      for (let i = 0; i < r.length; i++) {
        const p = r[i], q = r[(i + 1) % r.length];
        if ((p[1] <= y && q[1] > y) || (q[1] <= y && p[1] > y)) xs.push(p[0] + ((y - p[1]) / (q[1] - p[1])) * (q[0] - p[0]));
      }
    }
    xs.sort((m, n) => m - n);
    const row: [Pt, Pt][] = [];
    for (let i = 0; i + 1 < xs.length; i += 2) row.push([[xs[i], y], [xs[i + 1], y]]);
    segs.push(row);
  }
  // serpentina: righe alterne invertite, segmenti vicini uniti in una polilinea
  const lines: Pt[][] = [];
  let cur: Pt[] | null = null;
  segs.forEach((row, j) => {
    const ordered = j % 2 === 0 ? row : row.map(([p, q]) => [q, p] as [Pt, Pt]).reverse();
    for (const [p, q] of ordered) {
      const last = cur?.[cur.length - 1];
      if (cur && last && Math.hypot(last[0] - p[0], last[1] - p[1]) <= spacing * 1.6) cur.push(p, q);
      else {
        if (cur) lines.push(cur);
        cur = [p, q];
      }
    }
  });
  if (cur) lines.push(cur);
  // ruota indietro
  return lines.map((l) => l.map(([x, y]) => [x * c - y * s, x * s + y * c] as Pt));
}

/** Perimetri e riempimento di uno strato. */
export function layerPaths(section: CrossSection, m: Machine, layerIndex: number): { perimeters: Pt[][]; infill: Pt[][] } {
  const w = m.nozzleMm;
  const perimeters: Pt[][] = [];
  let inner: CrossSection | null = null;
  for (let k = 0; k < m.walls; k++) {
    const off = section.offset(-(w / 2 + k * w), "Miter", 2);
    if (off.isEmpty()) break;
    perimeters.push(...ringsOf(off));
    inner = off;
  }
  let infill: Pt[][] = [];
  if (m.infill === "zigzag" && inner) {
    const region = section.offset(-(m.walls * w - w * 0.15), "Miter", 2);
    if (!region.isEmpty()) infill = zigzag(region, Math.max(m.infillSpacingMm, w), layerIndex % 2 === 0 ? 45 : -45);
  }
  return { perimeters, infill };
}

export interface Overhang {
  layer: number;
  z: number;
  areaMm2: number;
  /** contorni della zona a sbalzo (per l'anteprima) */
  rings: Pt[][];
}

/** Zone di uno strato che sporgono oltre lo sbalzo ammesso rispetto allo strato sotto. */
export function findOverhangs(layers: { index: number; z: number; section: CrossSection }[], m: Machine, layerStep = 1): Overhang[] {
  const out: Overhang[] = [];
  const reach = m.layerMm * layerStep * Math.tan((m.maxOverhangDeg * Math.PI) / 180) + m.nozzleMm * 0.25;
  const minArea = m.nozzleMm * m.nozzleMm * 2;
  for (let i = 1; i < layers.length; i++) {
    const below = layers[i - 1].section.offset(reach, "Round", 2, 24);
    const extra = layers[i].section.subtract(below);
    const area = extra.area();
    if (area > minArea) out.push({ layer: layers[i].index, z: layers[i].z, areaMm2: area, rings: ringsOf(extra) });
  }
  return out;
}

function polyLen(p: Pt[], closed: boolean): number {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  if (closed && p.length > 2) L += Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]);
  return L;
}

export interface Estimate {
  layers: number;
  extrudeM: number;
  travelM: number;
  volumeM3: number;
  kg: number;
  hours: number;
  materialCost: number;
  machineCost: number;
  total: number;
}

/** Preventivo dai percorsi (con layerStep > 1 i valori dello strato campionato valgono per i saltati). */
export function estimate(layers: { perimeters: Pt[][]; infill: Pt[][] }[], m: Machine, layerStep = 1, totalLayers = layers.length): Estimate {
  let ext = 0, travel = 0;
  for (const l of layers) {
    let last: Pt | null = null;
    const moveTo = (p: Pt) => {
      if (last) travel += Math.hypot(p[0] - last[0], p[1] - last[1]);
    };
    for (const r of l.perimeters) {
      moveTo(r[0]);
      ext += polyLen(r, true);
      last = r[0];
    }
    for (const s of l.infill) {
      moveTo(s[0]);
      ext += polyLen(s, false);
      last = s[s.length - 1];
    }
  }
  ext *= layerStep;
  travel *= layerStep;
  const volumeMm3 = ext * m.nozzleMm * m.layerMm;
  const volumeM3 = volumeMm3 / 1e9;
  const kg = volumeM3 * m.material.densityKgM3;
  const hours = (ext / m.speedMmS + travel / m.travelMmS) / 3600;
  const materialCost = kg * m.material.costPerKg;
  const machineCost = hours * m.machineCostH;
  return {
    layers: totalLayers,
    extrudeM: ext / 1000,
    travelM: travel / 1000,
    volumeM3,
    kg,
    hours,
    materialCost,
    machineCost,
    total: materialCost + machineCost,
  };
}

/**
 * G-code generico (G21/G90): G0 per gli spostamenti, G1 per la deposizione.
 * Con gcodeE l'asse E è volumetrico (mm³ depositati): va adattato al firmware.
 * Le coordinate partono dall'angolo del volume di stampa (X/Y ≥ 0, Z dal piano).
 */
export function toGcode(
  layers: { index: number; z: number; perimeters: Pt[][]; infill: Pt[][] }[],
  m: Machine,
  meta: { name: string; origin: [number, number, number] },
): string {
  const f = (n: number) => (Math.round(n * 100) / 100).toString();
  const [ox, oy, oz] = meta.origin;
  const out: string[] = [
    `; Kalco3D Building — ${meta.name}`,
    `; macchina: ${m.label} · ugello ${m.nozzleMm} mm · strato ${m.layerMm} mm · ${layers.length} strati`,
    `; G-code generico: verificare con il produttore della macchina prima di stampare`,
    m.gcodeE ? "; E volumetrico in mm³ (M200 / modalità volumetrica del firmware)" : "; senza asse E: la pompa si comanda dal controllo della macchina",
    "G21 ; millimetri",
    "G90 ; coordinate assolute",
    m.gcodeE ? "M83 ; E relativo" : "",
  ].filter(Boolean);
  const feed = Math.round(m.speedMmS * 60), travelFeed = Math.round(m.travelMmS * 60);
  const area = m.nozzleMm * m.layerMm;
  let last: Pt | null = null;
  const draw = (pts: Pt[], closed: boolean) => {
    const path = closed ? [...pts, pts[0]] : pts;
    out.push(`G0 X${f(path[0][0] - ox)} Y${f(path[0][1] - oy)} F${travelFeed}`);
    let prev = path[0];
    for (let i = 1; i < path.length; i++) {
      const p = path[i];
      const d = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      if (d < 1e-6) continue;
      out.push(`G1 X${f(p[0] - ox)} Y${f(p[1] - oy)}${m.gcodeE ? ` E${f(d * area)}` : ""} F${feed}`);
      prev = p;
    }
    last = prev;
  };
  for (const l of layers) {
    const z = l.z - m.layerMm / 2 + m.layerMm - oz; // quota superiore dello strato
    out.push(`; strato ${l.index + 1}`, `G0 Z${f(z)} F${travelFeed}`);
    for (const r of l.perimeters) draw(r, true);
    for (const s of l.infill) draw(s, false);
  }
  void last;
  out.push("; fine", `G0 Z${f((layers[layers.length - 1]?.z ?? 0) - oz + m.layerMm * 5)} F${travelFeed}`);
  return out.join("\n") + "\n";
}

export interface Piece {
  index: number;
  solid: Manifold;
  /** angolo minimo del pezzo nel modello montato, mm */
  min: [number, number, number];
  size: [number, number, number];
}

/** Il modello entra nel volume della macchina? */
export function fitsVolume(solid: Manifold, m: Machine): boolean {
  const b = solid.boundingBox();
  return b.max[0] - b.min[0] <= m.volume.x * 0.98 && b.max[1] - b.min[1] <= m.volume.y * 0.98 && b.max[2] - b.min[2] <= m.volume.z * 0.98;
}

/** Pezzi numerati dal basso verso l'alto, poi da sinistra a destra e da davanti a dietro. */
export function numberPieces(_w: ManifoldToplevel, parts: Manifold[]): Piece[] {
  const pcs = parts.map((solid) => {
    const b = solid.boundingBox();
    return {
      solid,
      min: [b.min[0], b.min[1], b.min[2]] as [number, number, number],
      size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]] as [number, number, number],
    };
  });
  const r = (v: number) => Math.round(v);
  pcs.sort((a, b) => r(a.min[2]) - r(b.min[2]) || r(a.min[1]) - r(b.min[1]) || r(a.min[0]) - r(b.min[0]));
  return pcs.map((p, i) => ({ index: i + 1, ...p }));
}
