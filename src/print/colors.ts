// Riduzione dei colori della texture a N filamenti (stampa multicolore).
// k-means nello spazio Lab (distanze vicine a come l'occhio percepisce il
// colore), pesato per area, inizializzazione k-means++ deterministica.
import type { PrintMesh } from "./meshOps";

type Rgb = [number, number, number];

function srgbToLinear(c: number) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function rgbToLab([r, g, b]: Rgb): Rgb {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function toHex([r, g, b]: Rgb): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** generatore pseudo-casuale deterministico: stesso modello → stessi colori */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface Quantized {
  /** indice del colore per triangolo */
  labels: Uint16Array;
  /** colori sRGB 0..1, ordinati dal più usato */
  palette: Rgb[];
}

/**
 * @param colors rgb (0..1) per triangolo
 * @param weights area per triangolo
 * @param k numero di filamenti desiderato
 */
export function quantizeColors(colors: Float32Array, weights: Float32Array, k: number, iterations = 16): Quantized {
  const n = colors.length / 3;
  const labs = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const l = rgbToLab([colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]]);
    labs.set(l, i * 3);
  }
  k = Math.max(1, Math.min(k, n));
  const rand = lcg(12345);
  // k-means++ su un campione (velocità su mesh grandi)
  const sampleIdx: number[] = [];
  const stride = Math.max(1, Math.floor(n / 20000));
  for (let i = 0; i < n; i += stride) sampleIdx.push(i);
  const centers: number[][] = [];
  // primo centro: il colore con più area
  let best = 0;
  for (const i of sampleIdx) if (weights[i] > weights[best]) best = i;
  centers.push([labs[best * 3], labs[best * 3 + 1], labs[best * 3 + 2]]);
  const d2 = (i: number, c: number[]) =>
    (labs[i * 3] - c[0]) ** 2 + (labs[i * 3 + 1] - c[1]) ** 2 + (labs[i * 3 + 2] - c[2]) ** 2;
  while (centers.length < k) {
    let total = 0;
    const dist = sampleIdx.map((i) => {
      const d = Math.min(...centers.map((c) => d2(i, c))) * weights[i];
      total += d;
      return d;
    });
    if (total <= 0) break; // meno colori distinti di k
    let r = rand() * total;
    let pick = sampleIdx[sampleIdx.length - 1];
    for (let j = 0; j < sampleIdx.length; j++) {
      r -= dist[j];
      if (r <= 0) {
        pick = sampleIdx[j];
        break;
      }
    }
    centers.push([labs[pick * 3], labs[pick * 3 + 1], labs[pick * 3 + 2]]);
  }
  const K = centers.length;
  const labels = new Uint16Array(n);
  for (let it = 0; it < iterations; it++) {
    const sum = Array.from({ length: K }, () => [0, 0, 0, 0]);
    let changed = 0;
    for (let i = 0; i < n; i++) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < K; c++) {
        const d = d2(i, centers[c]);
        if (d < bd) { bd = d; bi = c; }
      }
      if (labels[i] !== bi) changed++;
      labels[i] = bi;
      const w = weights[i] || 1e-9;
      sum[bi][0] += labs[i * 3] * w; sum[bi][1] += labs[i * 3 + 1] * w; sum[bi][2] += labs[i * 3 + 2] * w; sum[bi][3] += w;
    }
    for (let c = 0; c < K; c++) {
      if (sum[c][3] > 0) centers[c] = [sum[c][0] / sum[c][3], sum[c][1] / sum[c][3], sum[c][2] / sum[c][3]];
    }
    if (it > 0 && changed === 0) break;
  }
  // colore rappresentativo in sRGB = media pesata dei colori reali del gruppo
  const acc = Array.from({ length: K }, () => [0, 0, 0, 0]);
  for (let i = 0; i < n; i++) {
    const w = weights[i] || 1e-9;
    const a = acc[labels[i]];
    a[0] += colors[i * 3] * w; a[1] += colors[i * 3 + 1] * w; a[2] += colors[i * 3 + 2] * w; a[3] += w;
  }
  // colori quasi uguali (due neri, due marroni) non meritano due filamenti:
  // si fondono i gruppi più vicini di MIN_DELTA_E nello spazio Lab
  const MIN_DELTA_E = 18;
  const parent = Array.from({ length: K }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const labOf = (a: number[]) => rgbToLab([a[0] / a[3], a[1] / a[3], a[2] / a[3]]);
  for (;;) {
    let bestPair: [number, number] | null = null;
    let bestD = MIN_DELTA_E;
    const roots = [...new Set(Array.from({ length: K }, (_, i) => find(i)))].filter((r) => acc[r][3] > 0);
    for (let x = 0; x < roots.length; x++) {
      for (let y = x + 1; y < roots.length; y++) {
        const la = labOf(acc[roots[x]]), lb = labOf(acc[roots[y]]);
        const d = Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
        if (d < bestD) { bestD = d; bestPair = [roots[x], roots[y]]; }
      }
    }
    if (!bestPair) break;
    const [keep, drop] = bestPair;
    for (let c = 0; c < 4; c++) acc[keep][c] += acc[drop][c];
    acc[drop] = [0, 0, 0, 0];
    parent[drop] = keep;
  }
  for (let i = 0; i < n; i++) labels[i] = find(labels[i]);

  // ordina per area (filamento 1 = colore principale) ed elimina gruppi vuoti
  const order = acc.map((a, i) => ({ i, w: a[3] })).filter((x) => x.w > 0).sort((a, b) => b.w - a.w);
  const remap = new Int32Array(K).fill(-1);
  order.forEach((o, j) => (remap[o.i] = j));
  for (let i = 0; i < n; i++) labels[i] = remap[labels[i]];
  const palette = order.map(({ i }) => [acc[i][0] / acc[i][3], acc[i][1] / acc[i][3], acc[i][2] / acc[i][3]] as Rgb);
  return { labels, palette };
}

/**
 * Toglie le "macchioline": un triangolo prende il colore della maggioranza dei
 * suoi vicini se almeno 2 su 3 concordano su un colore diverso. Le zone di
 * colore diventano campiture pulite, che un cambio filamento riesce a stampare.
 */
export function smoothLabels(m: PrintMesh, passes = 3): number {
  if (!m.label) return 0;
  const T = m.tri.length / 3;
  const key = (a: number, b: number) => Math.min(a, b) * 4_294_967_296 + Math.max(a, b);
  const edgeTris = new Map<number, number[]>();
  for (let t = 0; t < T; t++) {
    for (let e = 0; e < 3; e++) {
      const k = key(m.tri[t * 3 + e], m.tri[t * 3 + ((e + 1) % 3)]);
      const l = edgeTris.get(k);
      if (l) l.push(t);
      else edgeTris.set(k, [t]);
    }
  }
  const nb: number[][] = Array.from({ length: T }, () => []);
  for (const l of edgeTris.values()) {
    if (l.length === 2) {
      nb[l[0]].push(l[1]);
      nb[l[1]].push(l[0]);
    }
  }
  let changed = 0;
  for (let p = 0; p < passes; p++) {
    const next = Uint16Array.from(m.label);
    for (let t = 0; t < T; t++) {
      const counts = new Map<number, number>();
      for (const x of nb[t]) counts.set(m.label[x], (counts.get(m.label[x]) ?? 0) + 1);
      for (const [lab, c] of counts) {
        if (lab !== m.label[t] && c >= 2) {
          next[t] = lab;
          changed++;
          break;
        }
      }
    }
    m.label.set(next);
  }
  return changed;
}
