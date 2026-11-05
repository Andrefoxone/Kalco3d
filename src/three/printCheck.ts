// Controllo di stampabilità e preparazione STL per gli slicer.
import * as THREE from "three";

export interface PrintReport {
  triangles: number;
  /** spigoli usati da un solo triangolo: buchi nella superficie */
  openEdges: number;
  /** spigoli condivisi da più di due triangoli: geometria ambigua */
  nonManifoldEdges: number;
  /** superficie chiusa e senza ambiguità = stampabile così com'è */
  watertight: boolean;
  /** dimensioni nello spazio della scena */
  size: { x: number; y: number; z: number };
}

/** Analizza tutte le mesh di un oggetto (trasformazioni mondo incluse). */
export function analyzePrintability(root: THREE.Object3D): PrintReport {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const sz = box.getSize(new THREE.Vector3());
  const q = 1 / ((sz.length() || 1) * 1e-6);
  const keyToId = new Map<string, number>();
  const edgeCount = new Map<number, number>();
  let triangles = 0;
  const v = new THREE.Vector3();

  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const geom = obj.geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute("position");
    if (!pos) return;
    // saldatura per posizione: le cuciture UV non contano come buchi
    const ids = new Int32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
      const k = `${Math.round(v.x * q)},${Math.round(v.y * q)},${Math.round(v.z * q)}`;
      let id = keyToId.get(k);
      if (id === undefined) {
        id = keyToId.size;
        keyToId.set(k, id);
      }
      ids[i] = id;
    }
    const index = geom.index;
    const triCount = index ? index.count / 3 : pos.count / 3;
    const at = (t: number) => ids[index ? index.getX(t) : t];
    for (let t = 0; t < triCount; t++) {
      const a = at(t * 3), b = at(t * 3 + 1), c = at(t * 3 + 2);
      if (a === b || b === c || a === c) continue; // degenere
      triangles++;
      for (const [p, r] of [[a, b], [b, c], [c, a]]) {
        const lo = Math.min(p, r), hi = Math.max(p, r);
        const key = lo * 4_294_967_296 + hi;
        edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
      }
    }
  });

  let openEdges = 0;
  let nonManifoldEdges = 0;
  for (const n of edgeCount.values()) {
    if (n === 1) openEdges++;
    else if (n > 2) nonManifoldEdges++;
  }
  return {
    triangles,
    openEdges,
    nonManifoldEdges,
    watertight: triangles > 0 && openEdges === 0 && nonManifoldEdges === 0,
    size: { x: sz.x, y: sz.y, z: sz.z },
  };
}

/**
 * Converte un STL binario di three (Y in alto, unità della scena) in uno pronto
 * per lo slicer: Z in alto, lato più lungo = longestMm millimetri, appoggiato
 * sul piano (z minima = 0) e centrato in X/Y.
 */
export function stlToPrintSpace(stl: ArrayBuffer, longestMm: number): ArrayBuffer {
  const out = stl.slice(0);
  const dv = new DataView(out);
  const n = dv.getUint32(80, true);
  // 1° passaggio: bounding box nello spazio ruotato (x, -z, y)
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < n; t++) {
    const base = 84 + t * 50 + 12;
    for (let k = 0; k < 3; k++) {
      const o = base + k * 12;
      const x = dv.getFloat32(o, true), y = dv.getFloat32(o + 4, true), z = dv.getFloat32(o + 8, true);
      const r = [x, -z, y];
      for (let a = 0; a < 3; a++) {
        if (r[a] < min[a]) min[a] = r[a];
        if (r[a] > max[a]) max[a] = r[a];
      }
    }
  }
  const longest = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  const s = longestMm / longest;
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2, z0 = min[2];
  // 2° passaggio: rotazione +90° attorno a X (det = +1: l'orientamento delle facce resta valido)
  for (let t = 0; t < n; t++) {
    const base = 84 + t * 50;
    const nx = dv.getFloat32(base, true), ny = dv.getFloat32(base + 4, true), nz = dv.getFloat32(base + 8, true);
    dv.setFloat32(base, nx, true);
    dv.setFloat32(base + 4, -nz, true);
    dv.setFloat32(base + 8, ny, true);
    for (let k = 0; k < 3; k++) {
      const o = base + 12 + k * 12;
      const x = dv.getFloat32(o, true), y = dv.getFloat32(o + 4, true), z = dv.getFloat32(o + 8, true);
      dv.setFloat32(o, (x - cx) * s, true);
      dv.setFloat32(o + 4, (-z - cy) * s, true);
      dv.setFloat32(o + 8, (y - z0) * s, true);
    }
  }
  const header = new TextEncoder().encode(`Kalco3D - mm, Z-up, lato max ${longestMm} mm`.padEnd(80, " ").slice(0, 80));
  new Uint8Array(out, 0, 80).set(header);
  return out;
}

/**
 * Dimensione reale suggerita (mm) dal lato più lungo del file.
 * unit "m": motori AI in scala reale; unit "mm": file CAD (STEP/STL/DXF quasi
 * sempre in millimetri). Valori implausibili → 100 mm, da correggere a mano.
 */
export function suggestedLongestMm(sourceMaxDim: number | null, unit: "m" | "mm" = "m"): number {
  if (!sourceMaxDim || !(sourceMaxDim > 0)) return 100;
  if (unit === "mm") return sourceMaxDim >= 1 && sourceMaxDim <= 5000 ? Math.round(sourceMaxDim) : 100;
  if (sourceMaxDim > 0.005 && sourceMaxDim < 3) return Math.round(sourceMaxDim * 1000);
  return 100;
}
