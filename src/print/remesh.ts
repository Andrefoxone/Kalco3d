// Ricostruzione di riserva per mesh "impossibili" (spigoli condivisi da 3+
// facce, superfici che si incrociano, gusci aperti): il modello viene
// campionato su una griglia di voxel e rifuso come un unico solido manifold
// con Manifold.levelSet. È la strada degli slicer per i file rotti.
//
// Dentro/fuori: per ogni colonna della griglia, lungo X, Y e Z, si contano gli
// attraversamenti della superficie (parità). Un buco o una faccia doppia
// sbagliano al massimo una direzione: vince la maggioranza su tre.
// I colori tornano dalla superficie originale: ogni triangolo nuovo prende
// l'etichetta del triangolo originale più vicino.
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import type { ManifoldToplevel } from "manifold-3d";
import { bounds, type PrintMesh } from "./meshOps";

export interface RemeshResult {
  mesh: PrintMesh;
  /** lato del voxel in mm: i dettagli più piccoli vengono smussati */
  cellMm: number;
}

export function voxelRemesh(w: ManifoldToplevel, src: PrintMesh, cells = 160): RemeshResult {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(src.vert, 3));
  geom.setIndex(new THREE.BufferAttribute(src.tri, 1));
  const bvh = new MeshBVH(geom);

  const b = bounds(src.vert);
  const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const cell = Math.max(...size) / cells;
  const pad = 2;
  const origin = [b.min[0] - pad * cell, b.min[1] - pad * cell, b.min[2] - pad * cell];
  const dim = size.map((s) => Math.ceil(s / cell) + pad * 2) as [number, number, number];
  const [nx, ny, nz] = dim;
  const at = (i: number, j: number, k: number) => (k * ny + j) * nx + i;

  // voti "dentro" da tre direzioni
  const votes = new Uint8Array(nx * ny * nz);
  const ray = new THREE.Ray();
  const eps = cell * 1e-3;
  for (let a = 0; a < 3; a++) {
    const u = (a + 1) % 3, v = (a + 2) % 3;
    const dir = [0, 0, 0];
    dir[a] = 1;
    ray.direction.set(dir[0], dir[1], dir[2]);
    for (let iu = 0; iu < dim[u]; iu++) {
      for (let iv = 0; iv < dim[v]; iv++) {
        const o = [0, 0, 0];
        o[a] = origin[a] - cell;
        // leggero spostamento: evita di colpire esattamente spigoli e vertici
        o[u] = origin[u] + (iu + 0.5) * cell + cell * 0.0137;
        o[v] = origin[v] + (iv + 0.5) * cell - cell * 0.0071;
        ray.origin.set(o[0], o[1], o[2]);
        // ogni attraversamento: entrata (+1) se la faccia guarda contro il
        // raggio, uscita (−1) altrimenti. Con gusci sovrapposti il "numero di
        // avvolgimento" resta > 0 per tutto l'interno, dove la parità sbaglia
        const hits = bvh
          .raycast(ray, THREE.DoubleSide)
          .map((h) => ({ t: h.distance, s: (h.face?.normal.getComponent(a) ?? 0) < 0 ? 1 : -1 }))
          .sort((x, y) => x.t - y.t);
        // facce doppie coincidenti (stesso verso) contano una volta sola
        const ev: { t: number; s: number }[] = [];
        for (const h of hits) {
          const last = ev[ev.length - 1];
          if (last && h.t - last.t <= eps && last.s === h.s) continue;
          ev.push(h);
        }
        let total = 0;
        for (const e of ev) total += e.s;
        const mark = (t0: number, t1: number) => {
          const c0 = Math.max(0, Math.ceil((t0 + o[a] - origin[a]) / cell - 0.5));
          const c1 = Math.min(dim[a] - 1, Math.floor((t1 + o[a] - origin[a]) / cell - 0.5));
          for (let c = c0; c <= c1; c++) {
            const idx = [0, 0, 0];
            idx[a] = c;
            idx[u] = iu;
            idx[v] = iv;
            votes[at(idx[0], idx[1], idx[2])]++;
          }
        };
        if (total === 0) {
          let wind = 0;
          for (let p = 0; p + 1 < ev.length; p++) {
            wind += ev[p].s;
            if (wind > 0) mark(ev[p].t, ev[p + 1].t);
          }
        } else {
          // versi incoerenti su questo raggio (faccia isolata, guscio aperto): parità
          for (let p = 0; p + 1 < ev.length; p += 2) mark(ev[p].t, ev[p + 1].t);
        }
      }
    }
  }

  // campo +1 dentro / -1 fuori, sfumato una volta (superficie meno a gradini)
  const raw = new Float32Array(votes.length);
  for (let i = 0; i < votes.length; i++) raw[i] = votes[i] >= 2 ? 1 : -1;
  const field = new Float32Array(votes.length);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let s = 0, n = 0;
        for (let dk = -1; dk <= 1; dk++) {
          const kk = k + dk;
          if (kk < 0 || kk >= nz) continue;
          for (let dj = -1; dj <= 1; dj++) {
            const jj = j + dj;
            if (jj < 0 || jj >= ny) continue;
            for (let di = -1; di <= 1; di++) {
              const ii = i + di;
              if (ii < 0 || ii >= nx) continue;
              // il centro pesa di più: il volume non si gonfia né si assottiglia
              const wgt = di === 0 && dj === 0 && dk === 0 ? 4 : 1;
              s += raw[at(ii, jj, kk)] * wgt;
              n += wgt;
            }
          }
        }
        field[at(i, j, k)] = s / n;
      }
    }
  }

  // campionamento trilineare tra i centri dei voxel; fuori griglia = fuori
  const sample = (p: readonly number[]) => {
    const gx = (p[0] - origin[0]) / cell - 0.5;
    const gy = (p[1] - origin[1]) / cell - 0.5;
    const gz = (p[2] - origin[2]) / cell - 0.5;
    const i0 = Math.floor(gx), j0 = Math.floor(gy), k0 = Math.floor(gz);
    const fx = gx - i0, fy = gy - j0, fz = gz - k0;
    let r = 0;
    for (let c = 0; c < 8; c++) {
      const i = i0 + (c & 1), j = j0 + ((c >> 1) & 1), k = k0 + ((c >> 2) & 1);
      const val = i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? -1 : field[at(i, j, k)];
      r += val * (c & 1 ? fx : 1 - fx) * ((c >> 1) & 1 ? fy : 1 - fy) * ((c >> 2) & 1 ? fz : 1 - fz);
    }
    return r;
  };

  // piccolo scostamento: il campo sfumato vale spesso esattamente 0 sul bordo
  // tra dentro e fuori, e uno zero esatto su un nodo della griglia crea punti
  // "pizzicati" (due superfici che si toccano in un vertice)
  const solid = w.Manifold.levelSet(
    (p) => sample(p) + 0.0731,
    {
      min: [origin[0], origin[1], origin[2]],
      max: [origin[0] + nx * cell, origin[1] + ny * cell, origin[2] + nz * cell],
    },
    cell,
  );
  const out = solid.getMesh();
  const np = out.numProp;
  const nv = out.vertProperties.length / np;
  const vert = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    vert[i * 3] = out.vertProperties[i * np];
    vert[i * 3 + 1] = out.vertProperties[i * np + 1];
    vert[i * 3 + 2] = out.vertProperties[i * np + 2];
  }
  const tri = new Uint32Array(out.triVerts);

  // colori: etichetta del triangolo originale più vicino
  let label: Uint16Array | undefined;
  if (src.label) {
    label = new Uint16Array(tri.length / 3);
    const pnt = new THREE.Vector3();
    const hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
    for (let t = 0; t < label.length; t++) {
      const a = tri[t * 3] * 3, b2 = tri[t * 3 + 1] * 3, c = tri[t * 3 + 2] * 3;
      pnt.set(
        (vert[a] + vert[b2] + vert[c]) / 3,
        (vert[a + 1] + vert[b2 + 1] + vert[c + 1]) / 3,
        (vert[a + 2] + vert[b2 + 2] + vert[c + 2]) / 3,
      );
      const r = bvh.closestPointToPoint(pnt, hit);
      label[t] = r ? src.label[r.faceIndex] : 0;
    }
  }
  geom.dispose();
  return { mesh: { vert, tri, label }, cellMm: cell };
}
