// Stampabilità "vera": dopo che il modello è un solido valido,
// 1. si tolgono i frammenti staccati troppo piccoli per stamparsi (briciole
//    tipiche dei modelli AI) e si contano le parti staccate grandi;
// 2. si rinforzano le pareti più sottili di quanto l'ugello possa stampare:
//    ogni vertice di una parete sottile viene spinto verso l'esterno lungo la
//    normale, così la parete si ispessisce da entrambi i lati. Solo dove serve:
//    il resto del modello resta identico.
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import type { Manifold, ManifoldToplevel } from "manifold-3d";

export interface Tracked {
  solid: Manifold;
  modelRun: number;
  baseRun: number | null;
}

export interface FragmentReport {
  /** frammenti eliminati perché troppo piccoli */
  removed: number;
  /** parti staccate dal corpo principale ma abbastanza grandi da tenere */
  detached: number;
}

/** Spessore minimo stampabile: due linee dell'ugello. */
export function minWallMm(nozzleMm: number): number {
  return Math.round(nozzleMm * 2 * 100) / 100;
}

export function removeFragments(w: ManifoldToplevel, t: Tracked): { tracked: Tracked; report: FragmentReport } {
  const parts = t.solid.decompose();
  if (parts.length <= 1) return { tracked: t, report: { removed: 0, detached: 0 } };
  const vols = parts.map((p) => p.volume());
  const biggest = Math.max(...vols);
  // briciola: meno di 1 mm³ o meno dello 0,3% del corpo principale
  const minVol = Math.max(1, biggest * 0.003);
  const keep = parts.filter((_, i) => vols[i] >= minVol);
  const removed = parts.length - keep.length;
  if (removed === 0) return { tracked: t, report: { removed: 0, detached: parts.length - 1 } };
  const solid = keep.length === 1 ? keep[0] : w.Manifold.union(keep);
  return { tracked: { ...t, solid }, report: { removed, detached: keep.length - 1 } };
}

export interface ReinforceReport {
  /** quota della superficie che è stata ispessita (0..1) */
  share: number;
  /** spinta massima applicata a un lato della parete, mm */
  maxPushMm: number;
  applied: boolean;
}

/**
 * Ispessisce le pareti sotto thresholdMm. Ogni lato si sposta al massimo di
 * maxPushMm (di default metà della soglia): pareti quasi nulle diventano
 * stampabili senza gonfiare il modello.
 */
export function reinforceThin(
  w: ManifoldToplevel,
  t: Tracked,
  thresholdMm: number,
  maxPushMm = thresholdMm / 2,
): { tracked: Tracked; report: ReinforceReport } {
  const none = { tracked: t, report: { share: 0, maxPushMm: 0, applied: false } };
  const mesh = t.solid.getMesh();
  const np = mesh.numProp;
  const vp = mesh.vertProperties;
  const nv = vp.length / np;
  const tv = mesh.triVerts;
  const T = tv.length / 3;
  if (nv === 0) return none;

  // posizioni e normali per vertice (pesate per area)
  const pos = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    pos[i * 3] = vp[i * np];
    pos[i * 3 + 1] = vp[i * np + 1];
    pos[i * 3 + 2] = vp[i * np + 2];
  }
  const nrm = new Float32Array(nv * 3);
  const vertArea = new Float32Array(nv);
  const neighbors: number[][] = Array.from({ length: nv }, () => []);
  for (let f = 0; f < T; f++) {
    const a = tv[f * 3], b = tv[f * 3 + 1], c = tv[f * 3 + 2];
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area = Math.hypot(nx, ny, nz) / 2;
    for (const v of [a, b, c]) {
      nrm[v * 3] += nx; nrm[v * 3 + 1] += ny; nrm[v * 3 + 2] += nz;
      vertArea[v] += area / 3;
    }
    neighbors[a].push(b, c); neighbors[b].push(a, c); neighbors[c].push(a, b);
  }
  for (let i = 0; i < nv; i++) {
    const l = Math.hypot(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]) || 1;
    nrm[i * 3] /= l; nrm[i * 3 + 1] /= l; nrm[i * 3 + 2] /= l;
  }

  // spessore per vertice: raggio verso l'interno fino all'altro lato
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geom.setIndex(new THREE.BufferAttribute(new Uint32Array(tv), 1));
  const bvh = new MeshBVH(geom);
  const ray = new THREE.Ray();
  const eps = 1e-3;
  let push = new Float32Array(nv);
  let any = false;
  for (let i = 0; i < nv; i++) {
    ray.direction.set(-nrm[i * 3], -nrm[i * 3 + 1], -nrm[i * 3 + 2]);
    ray.origin.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).addScaledVector(ray.direction, eps);
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
    if (!hit) continue;
    const thick = hit.distance + eps;
    if (thick < thresholdMm) {
      push[i] = Math.min(maxPushMm, (thresholdMm - thick) / 2);
      any = true;
    }
  }
  geom.dispose();
  if (!any) return none;

  // uniforma la spinta tra i vertici sottili vicini (niente bozzi); i vertici
  // con pareti già spesse non si muovono: con mesh rade sposterebbero facce intere
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(nv);
    for (let i = 0; i < nv; i++) {
      if (push[i] <= 0) continue;
      let s = push[i] * 2, n = 2;
      for (const j of neighbors[i]) if (push[j] > 0) { s += push[j]; n++; }
      next[i] = s / n;
    }
    push = next;
  }

  let pushedArea = 0, totalArea = 0, maxPush = 0;
  const out = new Float32Array(vp);
  for (let i = 0; i < nv; i++) {
    totalArea += vertArea[i];
    if (push[i] <= 0) continue;
    pushedArea += vertArea[i];
    maxPush = Math.max(maxPush, push[i]);
    out[i * np] += nrm[i * 3] * push[i];
    out[i * np + 1] += nrm[i * 3 + 1] * push[i];
    out[i * np + 2] += nrm[i * 3 + 2] * push[i];
  }

  try {
    const moved = new w.Mesh({
      numProp: np,
      vertProperties: out,
      triVerts: tv,
      mergeFromVert: mesh.mergeFromVert,
      mergeToVert: mesh.mergeToVert,
      runIndex: mesh.runIndex,
      runOriginalID: mesh.runOriginalID,
      faceID: mesh.faceID,
    });
    const solid = new w.Manifold(moved);
    if (solid.status() !== "NoError" || solid.volume() < t.solid.volume()) return none;
    return {
      tracked: { ...t, solid },
      report: { share: totalArea > 0 ? pushedArea / totalArea : 0, maxPushMm: maxPush, applied: true },
    };
  } catch {
    return none;
  }
}
