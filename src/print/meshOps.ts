// Operazioni sulla mesh per la stampa, su array semplici (testabili in Node).
// Una "PrintMesh" è indicizzata, in millimetri, Z in alto; ogni triangolo può
// avere un'etichetta (es. indice colore).

export interface PrintMesh {
  /** posizioni xyz */
  vert: Float32Array;
  /** indici dei triangoli (antiorario visto da fuori) */
  tri: Uint32Array;
  /** etichetta per triangolo (colore), opzionale */
  label?: Uint16Array;
}

/** Zuppa di triangoli (3 vertici ciascuno, non indicizzata) → mesh saldata. */
export function weld(soup: Float32Array, labels?: Uint16Array, tolerance = 1e-5): PrintMesh {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < soup.length; i += 3) {
    minX = Math.min(minX, soup[i]); maxX = Math.max(maxX, soup[i]);
    minY = Math.min(minY, soup[i + 1]); maxY = Math.max(maxY, soup[i + 1]);
    minZ = Math.min(minZ, soup[i + 2]); maxZ = Math.max(maxZ, soup[i + 2]);
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const q = 1 / (diag * tolerance);
  const ids = new Map<string, number>();
  const vert: number[] = [];
  const tri: number[] = [];
  const lab: number[] = [];
  const triCount = soup.length / 9;
  for (let t = 0; t < triCount; t++) {
    const idx: number[] = [];
    for (let c = 0; c < 3; c++) {
      const o = t * 9 + c * 3;
      const k = `${Math.round(soup[o] * q)},${Math.round(soup[o + 1] * q)},${Math.round(soup[o + 2] * q)}`;
      let id = ids.get(k);
      if (id === undefined) {
        id = vert.length / 3;
        ids.set(k, id);
        vert.push(soup[o], soup[o + 1], soup[o + 2]);
      }
      idx.push(id);
    }
    // triangoli degeneri (due vertici saldati insieme) vengono scartati
    if (idx[0] === idx[1] || idx[1] === idx[2] || idx[0] === idx[2]) continue;
    tri.push(idx[0], idx[1], idx[2]);
    lab.push(labels ? labels[t] : 0);
  }
  return {
    vert: Float32Array.from(vert),
    tri: Uint32Array.from(tri),
    label: labels ? Uint16Array.from(lab) : undefined,
  };
}

const ekey = (a: number, b: number) => a * 4_294_967_296 + b;

/** Rimuove triangoli duplicati (stessi tre vertici, in qualunque ordine). */
export function dedupeTriangles(m: PrintMesh): PrintMesh {
  const seen = new Set<string>();
  const tri: number[] = [];
  const lab: number[] = [];
  for (let t = 0; t < m.tri.length / 3; t++) {
    const s = [m.tri[t * 3], m.tri[t * 3 + 1], m.tri[t * 3 + 2]].sort((a, b) => a - b).join(",");
    if (seen.has(s)) continue;
    seen.add(s);
    tri.push(m.tri[t * 3], m.tri[t * 3 + 1], m.tri[t * 3 + 2]);
    lab.push(m.label ? m.label[t] : 0);
  }
  return { vert: m.vert, tri: Uint32Array.from(tri), label: m.label ? Uint16Array.from(lab) : undefined };
}

/**
 * Orienta le facce in modo coerente (ogni spigolo percorso in versi opposti dai
 * due triangoli che lo condividono), poi rivolge ogni parte connessa verso
 * l'esterno (volume con segno positivo). I modelli AI a volte hanno facce
 * girate: per uno slicer dentro e fuori si confondono.
 */
export function orientConsistently(m: PrintMesh): { mesh: PrintMesh; flipped: number } {
  const T = m.tri.length / 3;
  const tri = Uint32Array.from(m.tri);
  // spigolo non orientato → triangoli che lo usano
  const edgeTris = new Map<number, number[]>();
  for (let t = 0; t < T; t++) {
    for (let e = 0; e < 3; e++) {
      const a = tri[t * 3 + e], b = tri[t * 3 + ((e + 1) % 3)];
      const k = ekey(Math.min(a, b), Math.max(a, b));
      const list = edgeTris.get(k);
      if (list) list.push(t);
      else edgeTris.set(k, [t]);
    }
  }
  const hasDirected = (t: number, a: number, b: number) => {
    for (let e = 0; e < 3; e++) if (tri[t * 3 + e] === a && tri[t * 3 + ((e + 1) % 3)] === b) return true;
    return false;
  };
  const flip = (t: number) => {
    const x = tri[t * 3 + 1];
    tri[t * 3 + 1] = tri[t * 3 + 2];
    tri[t * 3 + 2] = x;
  };
  const comp = new Int32Array(T).fill(-1);
  let flipped = 0;
  let nComp = 0;
  for (let seed = 0; seed < T; seed++) {
    if (comp[seed] >= 0) continue;
    const c = nComp++;
    comp[seed] = c;
    const stack = [seed];
    const members: number[] = [];
    while (stack.length) {
      const t = stack.pop()!;
      members.push(t);
      for (let e = 0; e < 3; e++) {
        const a = tri[t * 3 + e], b = tri[t * 3 + ((e + 1) % 3)];
        const list = edgeTris.get(ekey(Math.min(a, b), Math.max(a, b)))!;
        if (list.length !== 2) continue; // bordi e spigoli ambigui: non propagare
        const n = list[0] === t ? list[1] : list[0];
        if (comp[n] >= 0) continue;
        // il vicino deve percorrere lo spigolo al contrario (b→a)
        if (!hasDirected(n, b, a)) {
          flip(n);
          flipped++;
        }
        comp[n] = c;
        stack.push(n);
      }
    }
    // verso l'esterno: volume con segno della componente > 0
    let vol = 0;
    for (const t of members) {
      const i = tri[t * 3] * 3, j = tri[t * 3 + 1] * 3, k = tri[t * 3 + 2] * 3;
      const v = m.vert;
      vol += v[i] * (v[j + 1] * v[k + 2] - v[j + 2] * v[k + 1])
        - v[i + 1] * (v[j] * v[k + 2] - v[j + 2] * v[k])
        + v[i + 2] * (v[j] * v[k + 1] - v[j + 1] * v[k]);
    }
    if (vol < 0) {
      for (const t of members) flip(t);
      flipped += members.length;
    }
  }
  return { mesh: { vert: m.vert, tri, label: m.label }, flipped };
}

/** Spigoli di bordo orientati (usati da un solo triangolo, nel verso del triangolo). */
export function boundaryEdges(m: PrintMesh): [number, number][] {
  const count = new Map<number, number>();
  const T = m.tri.length / 3;
  for (let t = 0; t < T; t++) {
    for (let e = 0; e < 3; e++) {
      const a = m.tri[t * 3 + e], b = m.tri[t * 3 + ((e + 1) % 3)];
      const k = ekey(Math.min(a, b), Math.max(a, b));
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  const out: [number, number][] = [];
  for (let t = 0; t < T; t++) {
    for (let e = 0; e < 3; e++) {
      const a = m.tri[t * 3 + e], b = m.tri[t * 3 + ((e + 1) % 3)];
      if (count.get(ekey(Math.min(a, b), Math.max(a, b))) === 1) out.push([a, b]);
    }
  }
  return out;
}

/** etichetta dei triangoli aggiunti dalla riparazione, prima di assegnare il colore */
export const UNSET_LABEL = 0xffff;

export type Triangulate2D = (polygons: [number, number][][]) => [number, number, number][];

/**
 * Chiude i buchi: concatena gli spigoli di bordo in anelli e li triangola
 * (proiezione sul piano medio dell'anello). I nuovi triangoli percorrono il
 * bordo al contrario, quindi restano orientati come il resto della mesh.
 * `triangulate` è quello di Manifold (robusto con anelli concavi);
 * in sua assenza si usa un ventaglio dal baricentro.
 */
export function fillHoles(
  m: PrintMesh,
  triangulate?: Triangulate2D,
  maxLoop = 20000,
): { mesh: PrintMesh; holes: number; skipped: number } {
  const edges = boundaryEdges(m);
  if (edges.length === 0) return { mesh: m, holes: 0, skipped: 0 };
  // prossimo vertice lungo il bordo (orientamento del triangolo: a→b)
  const next = new Map<number, number[]>();
  for (const [a, b] of edges) {
    const l = next.get(a);
    if (l) l.push(b);
    else next.set(a, [b]);
  }
  const vert = Array.from(m.vert);
  const tri = Array.from(m.tri);
  const lab = m.label ? Array.from(m.label) : null;
  let holes = 0;
  let skipped = 0;

  for (const [start] of edges) {
    if (!next.get(start)?.length) continue;
    // percorre l'anello
    const loop: number[] = [start];
    let cur = start;
    let ok = false;
    for (let guard = 0; guard < maxLoop; guard++) {
      const l = next.get(cur);
      if (!l || l.length === 0) break;
      const nx = l.pop()!;
      if (nx === start) {
        ok = true;
        break;
      }
      loop.push(nx);
      cur = nx;
    }
    if (!ok || loop.length < 3) {
      skipped++;
      continue;
    }
    // il riempimento percorre l'anello al contrario
    const ring = loop.slice().reverse();
    // etichetta provvisoria: verrà presa dai triangoli vicini (propagateLabels)
    const fillLabel = UNSET_LABEL;
    // normale di Newell dell'anello invertito
    let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i] * 3, q = ring[(i + 1) % ring.length] * 3;
      nx += (vert[p + 1] - vert[q + 1]) * (vert[p + 2] + vert[q + 2]);
      ny += (vert[p + 2] - vert[q + 2]) * (vert[p] + vert[q]);
      nz += (vert[p] - vert[q]) * (vert[p + 1] + vert[q + 1]);
      cx += vert[p]; cy += vert[p + 1]; cz += vert[p + 2];
    }
    cx /= ring.length; cy /= ring.length; cz /= ring.length;
    const nl = Math.hypot(nx, ny, nz);
    let tris: [number, number, number][] | null = null;
    if (triangulate && nl > 1e-12) {
      nx /= nl; ny /= nl; nz /= nl;
      // base (u, v) con u × v = n: l'anello appare antiorario nel piano
      const ax = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      let ux = ax[1] * nz - ax[2] * ny, uy = ax[2] * nx - ax[0] * nz, uz = ax[0] * ny - ax[1] * nx;
      const ul = Math.hypot(ux, uy, uz);
      ux /= ul; uy /= ul; uz /= ul;
      const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
      const poly: [number, number][] = ring.map((id) => {
        const dx = vert[id * 3] - cx, dy = vert[id * 3 + 1] - cy, dz = vert[id * 3 + 2] - cz;
        return [dx * ux + dy * uy + dz * uz, dx * vx + dy * vy + dz * vz];
      });
      try {
        const local = triangulate([poly]);
        if (local.length === ring.length - 2) tris = local.map(([a, b, c]) => [ring[a], ring[b], ring[c]]);
      } catch {
        tris = null;
      }
    }
    if (!tris) {
      // ventaglio dal baricentro: sempre valido per anelli quasi convessi
      const center = vert.length / 3;
      vert.push(cx, cy, cz);
      tris = ring.map((id, i) => [center, id, ring[(i + 1) % ring.length]]);
    }
    for (const [a, b, c] of tris) {
      tri.push(a, b, c);
      lab?.push(fillLabel);
    }
    holes++;
  }
  return {
    mesh: { vert: Float32Array.from(vert), tri: Uint32Array.from(tri), label: lab ? Uint16Array.from(lab) : undefined },
    holes,
    skipped,
  };
}

/** Riempie le etichette dei triangoli di riempimento con quella dei vicini. */
export function propagateLabels(m: PrintMesh, unset: (l: number) => boolean, passes = 4): void {
  if (!m.label) return;
  const T = m.tri.length / 3;
  const edgeTris = new Map<number, number[]>();
  for (let t = 0; t < T; t++) {
    for (let e = 0; e < 3; e++) {
      const a = m.tri[t * 3 + e], b = m.tri[t * 3 + ((e + 1) % 3)];
      const k = ekey(Math.min(a, b), Math.max(a, b));
      const l = edgeTris.get(k);
      if (l) l.push(t);
      else edgeTris.set(k, [t]);
    }
  }
  for (let p = 0; p < passes; p++) {
    for (let t = 0; t < T; t++) {
      if (!unset(m.label[t])) continue;
      for (let e = 0; e < 3; e++) {
        const a = m.tri[t * 3 + e], b = m.tri[t * 3 + ((e + 1) % 3)];
        for (const n of edgeTris.get(ekey(Math.min(a, b), Math.max(a, b))) ?? []) {
          if (n !== t && !unset(m.label[n])) {
            m.label[t] = m.label[n];
            break;
          }
        }
        if (!unset(m.label[t])) break;
      }
    }
  }
}

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export function bounds(vert: Float32Array): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vert.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      if (vert[i + a] < min[a]) min[a] = vert[i + a];
      if (vert[i + a] > max[a]) max[a] = vert[i + a];
    }
  }
  return { min, max };
}

/**
 * Scena three (Y in alto, unità qualsiasi) → spazio di stampa: Z in alto,
 * lato più lungo = longestMm, centrato in X/Y, appoggiato su z = 0.
 * Rotazione +90° attorno a X (determinante +1: l'orientamento resta valido).
 */
export function toPrintSpace(vertYUp: Float32Array, longestMm: number): Float32Array {
  const out = new Float32Array(vertYUp.length);
  for (let i = 0; i < vertYUp.length; i += 3) {
    out[i] = vertYUp[i];
    out[i + 1] = -vertYUp[i + 2];
    out[i + 2] = vertYUp[i + 1];
  }
  const b = bounds(out);
  const longest = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1;
  const s = longestMm / longest;
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
  for (let i = 0; i < out.length; i += 3) {
    out[i] = (out[i] - cx) * s;
    out[i + 1] = (out[i + 1] - cy) * s;
    out[i + 2] = (out[i + 2] - b.min[2]) * s;
  }
  return out;
}
