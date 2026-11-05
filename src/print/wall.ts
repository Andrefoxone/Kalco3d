// Spessore delle pareti: da un campione di triangoli si lancia un raggio verso
// l'interno (opposto alla normale) e si misura dove esce dall'altra parte.
// Le pareti più sottili di ~0,8 mm (2 linee di un ugello da 0,4) spesso non
// vengono stampate o si rompono.
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import type { PrintMesh } from "./meshOps";

export interface WallReport {
  /** spessore minimo significativo (1° percentile), mm */
  minMm: number;
  /** quota della superficie con pareti sotto la soglia (0..1) */
  thinShare: number;
  thresholdMm: number;
}

export function wallThickness(m: PrintMesh, thresholdMm = 0.8, maxSamples = 4000): WallReport {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(m.vert, 3));
  geom.setIndex(new THREE.BufferAttribute(Uint32Array.from(m.tri), 1));
  const bvh = new MeshBVH(geom);
  const T = m.tri.length / 3;
  const stride = Math.max(1, Math.floor(T / maxSamples));
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const n = new THREE.Vector3(), o = new THREE.Vector3();
  const ray = new THREE.Ray();
  const v = m.vert;
  const samples: { d: number; area: number }[] = [];
  const index = geom.index!.array; // il BVH può riordinare l'indice
  for (let t = 0; t < T; t += stride) {
    a.fromArray(v, index[t * 3] * 3);
    b.fromArray(v, index[t * 3 + 1] * 3);
    c.fromArray(v, index[t * 3 + 2] * 3);
    n.subVectors(b, a).cross(c.clone().sub(a));
    const area = n.length() / 2;
    if (area < 1e-9) continue;
    n.normalize();
    o.copy(a).add(b).add(c).divideScalar(3);
    ray.origin.copy(o).addScaledVector(n, -1e-3);
    ray.direction.copy(n).negate();
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
    if (!hit) continue;
    samples.push({ d: hit.distance + 1e-3, area });
  }
  if (samples.length === 0) return { minMm: Infinity, thinShare: 0, thresholdMm };
  samples.sort((x, y) => x.d - y.d);
  const total = samples.reduce((s, x) => s + x.area, 0);
  let thinArea = 0;
  for (const s of samples) if (s.d < thresholdMm) thinArea += s.area;
  // 1° percentile per area: ignora i singoli triangoli anomali
  let acc = 0;
  let minMm = samples[0].d;
  for (const s of samples) {
    acc += s.area;
    if (acc >= total * 0.01) {
      minMm = s.d;
      break;
    }
  }
  return { minMm, thinShare: thinArea / total, thresholdMm };
}
