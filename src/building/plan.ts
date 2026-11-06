// Dalla pianta (immagine) ai muri: i muri sono le zone "spesse" del disegno.
// Mobili, quote, testi, porte e finestre sono tratti sottili: un'apertura
// morfologica con un disco li cancella e lascia solo le pareti; dove c'erano
// porte e finestre restano i varchi. Le operazioni usano la trasformata di
// distanza euclidea (veloce anche su immagini grandi).
import type { CrossSection, ManifoldToplevel } from "manifold-3d";

export interface Mask {
  w: number;
  h: number;
  data: Uint8Array;
}

/** Pixel "d'inchiostro": non bianchi oppure colorati (riempimenti dei muri). */
export function inkMask(rgba: Uint8ClampedArray, w: number, h: number, lumMax = 215, satMin = 0.18): Mask {
  const data = new Uint8Array(w * h);
  for (let i = 0, p = 0; p < w * h; i += 4, p++) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    data[p] = rgba[i + 3] > 32 && (lum < lumMax || sat > satMin) ? 1 : 0;
  }
  return { w, h, data };
}

const INF = 1e20;

/** Trasformata di distanza 1D (Felzenszwalb–Huttenlocher) sul vettore f. */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Distanza al quadrato di ogni pixel dal pixel "acceso" (value) più vicino. */
export function edt2(m: Mask, value: 0 | 1): Float64Array {
  const { w, h, data } = m;
  const n = Math.max(w, h);
  const out = new Float64Array(w * h);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = data[y * w + x] === value ? 0 : INF;
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = d[x];
  }
  return out;
}

export function dilate(m: Mask, r: number): Mask {
  const d = edt2(m, 1), r2 = r * r;
  const data = new Uint8Array(m.w * m.h);
  for (let i = 0; i < data.length; i++) data[i] = d[i] <= r2 ? 1 : 0;
  return { w: m.w, h: m.h, data };
}

export function erode(m: Mask, r: number): Mask {
  const d = edt2(m, 0), r2 = r * r;
  const data = new Uint8Array(m.w * m.h);
  for (let i = 0; i < data.length; i++) data[i] = d[i] > r2 ? 1 : 0;
  return { w: m.w, h: m.h, data };
}

/** Muri: chiusura di 1 px (unisce tratteggi), apertura di raggio r, chiusura di raggio r (riempie i retini). */
export function wallMask(ink: Mask, r: number): Mask {
  const closed = erode(dilate(ink, 1.5), 1.5);
  const opened = dilate(erode(closed, r), r);
  return erode(dilate(opened, r), r);
}

export interface Component {
  id: number;
  area: number;
  /** riquadro in pixel */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Parti connesse (4-vicini). labels[p] = id della parte (0 = sfondo). */
export function components(m: Mask): { labels: Int32Array; list: Component[] } {
  const { w, h, data } = m;
  const labels = new Int32Array(w * h);
  const list: Component[] = [];
  const stack: number[] = [];
  for (let p = 0; p < w * h; p++) {
    if (!data[p] || labels[p]) continue;
    const id = list.length + 1;
    const c: Component = { id, area: 0, x0: w, y0: h, x1: 0, y1: 0 };
    labels[p] = id;
    stack.push(p);
    while (stack.length) {
      const q = stack.pop()!;
      const x = q % w, y = (q / w) | 0;
      c.area++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      if (x > 0 && data[q - 1] && !labels[q - 1]) { labels[q - 1] = id; stack.push(q - 1); }
      if (x < w - 1 && data[q + 1] && !labels[q + 1]) { labels[q + 1] = id; stack.push(q + 1); }
      if (y > 0 && data[q - w] && !labels[q - w]) { labels[q - w] = id; stack.push(q - w); }
      if (y < h - 1 && data[q + w] && !labels[q + w]) { labels[q + w] = id; stack.push(q + w); }
    }
    list.push(c);
  }
  return { labels, list };
}

/**
 * Pixel dei muri scelti → sezione 2D in mm (Y verso l'alto). Le righe di pixel
 * diventano rettangoli fusi da Clipper; la semplificazione toglie i gradini.
 */
export function maskToSection(
  w: ManifoldToplevel,
  labels: Int32Array,
  width: number,
  height: number,
  keep: Set<number>,
  mmPerPx: number,
): CrossSection {
  type Run = { x0: number; x1: number; y0: number };
  const rects: [number, number][][] = [];
  let open = new Map<string, Run>();
  const flush = (r: Run, y1: number) =>
    rects.push([
      [r.x0, -r.y0],
      [r.x1, -r.y0],
      [r.x1, -y1],
      [r.x0, -y1],
    ]);
  for (let y = 0; y <= height; y++) {
    const next = new Map<string, Run>();
    if (y < height) {
      let x = 0;
      while (x < width) {
        if (!keep.has(labels[y * width + x])) { x++; continue; }
        const x0 = x;
        while (x < width && keep.has(labels[y * width + x])) x++;
        const key = `${x0}:${x}`;
        // stessa corsa della riga sopra: si allunga il rettangolo
        next.set(key, open.get(key) ?? { x0, x1: x, y0: y });
        open.delete(key);
      }
    }
    for (const r of open.values()) flush(r, y);
    open = next;
  }
  if (!rects.length) return new w.CrossSection([]);
  // a blocchi, perché l'unione di migliaia di rettangoli in una volta è lenta
  let acc: CrossSection | null = null;
  for (let i = 0; i < rects.length; i += 400) {
    const part = new w.CrossSection(rects.slice(i, i + 400), "NonZero");
    acc = acc ? acc.add(part) : part;
  }
  return acc!.simplify(0.75).scale(mmPerPx);
}

/** Muri estrusi all'altezza voluta, come zuppa di triangoli in mm con Y in alto (come la scena). */
export function wallsSoup(section: CrossSection, heightMm: number): Float32Array {
  const b = section.bounds();
  const solid = section.translate([-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2]).extrude(heightMm);
  const mesh = solid.getMesh();
  const np = mesh.numProp, vp = mesh.vertProperties, tv = mesh.triVerts;
  const soup = new Float32Array(tv.length * 3);
  for (let i = 0; i < tv.length; i++) {
    const o = tv[i] * np;
    // Z in alto → Y in alto: (x, y, z) → (x, z, −y)
    soup[i * 3] = vp[o];
    soup[i * 3 + 1] = vp[o + 2];
    soup[i * 3 + 2] = -vp[o + 1];
  }
  return soup;
}
