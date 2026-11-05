// Motore di scultura per mesh caricate da GLB.
//
// Problema che risolve: i GLB (soprattutto quelli AI) hanno vertici duplicati
// nella stessa posizione lungo le cuciture UV, e il "volume chiuso" ha fronte e
// retro separati sul perimetro. Spostando ogni vertice per conto suo la
// superficie si strappa. Qui i vertici co-locati vengono raggruppati ("saldati")
// e ogni gruppo si muove come un punto solo, con una normale media.
//
// Altre scelte, ispirate ai pennelli di Blender:
//  - Alza/Abbassa usano la normale d'area del pennello (superficie più pulita);
//  - Gonfia usa la normale del singolo punto;
//  - Leviga è laplaciano (media dei vicini sul grafo della mesh), non verso il
//    centro del pennello: non appiattisce la forma;
//  - i punti rivolti dall'altra parte rispetto al tocco vengono ignorati, così
//    su oggetti sottili il retro non si muove;
//  - le "pennellate" sono distanziate (spacing): l'effetto non dipende dalla
//    velocità del mouse;
//  - BVH (three-mesh-bvh) per raycast e ricerca dei punti nel raggio.
import * as THREE from "three";
import {
  MeshBVH,
  acceleratedRaycast,
  INTERSECTED,
  NOT_INTERSECTED,
} from "three-mesh-bvh";

export type SculptMode = "raise" | "lower" | "inflate" | "smooth" | "pinch" | "flatten";

export interface Dab {
  mode: SculptMode;
  /** centro del pennello, spazio locale della mesh */
  center: THREE.Vector3;
  /** normale della faccia toccata, spazio locale */
  hitNormal: THREE.Vector3;
  /** raggio, spazio locale */
  radius: number;
  /** 0..1 */
  strength: number;
  /** solo per "flatten": piano di riferimento in spazio locale */
  plane?: { point: THREE.Vector3; normal: THREE.Vector3 };
}

function smoothFalloff(d: number, r: number): number {
  const t = 1 - d / r;
  if (t <= 0) return 0;
  return t * t * (3 - 2 * t);
}

/** Copia un attributo (anche interleaved o quantizzato) in un Float32 semplice. */
function toPlainFloat(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, size: number) {
  const out = new Float32Array(attr.count * size);
  for (let i = 0; i < attr.count; i++) {
    out[i * size] = attr.getX(i);
    if (size > 1) out[i * size + 1] = attr.getY(i);
    if (size > 2) out[i * size + 2] = attr.getZ(i);
  }
  return new THREE.BufferAttribute(out, size);
}

export class SculptTarget {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  readonly bvh: MeshBVH;
  private pos!: Float32Array;
  private nor!: Float32Array;

  /** vertice → gruppo di saldatura */
  readonly vertexGroup: Int32Array;
  /** CSR: membri di ogni gruppo */
  private groupStart: Int32Array;
  private groupMembers: Int32Array;
  /** CSR: gruppi adiacenti (spigoli della mesh) */
  private nbStart: Int32Array;
  private nbList: Int32Array;
  /** CSR: triangoli che toccano ogni gruppo (per le normali locali) */
  private triStart: Int32Array;
  private triList: Int32Array;
  readonly groupCount: number;
  private groupNormal: Float32Array;

  // buffer di lavoro riutilizzati tra le pennellate
  private stamp: Int32Array;
  private stampId = 0;
  private touched: Uint8Array;
  private hasTouched = false;
  private sel: number[] = [];
  private selFall: number[] = [];

  constructor(mesh: THREE.Mesh) {
    this.mesh = mesh;
    const geom = mesh.geometry as THREE.BufferGeometry;
    this.geometry = geom;

    // posizioni/normali come Float32 semplici: serve scrittura diretta e undo
    const p = geom.getAttribute("position");
    if (!(p instanceof THREE.BufferAttribute) || !(p.array instanceof Float32Array) || p.normalized) {
      geom.setAttribute("position", toPlainFloat(p, 3));
    }
    if (!geom.getAttribute("normal")) geom.computeVertexNormals();
    const n = geom.getAttribute("normal");
    if (!(n instanceof THREE.BufferAttribute) || !(n.array instanceof Float32Array) || n.normalized) {
      geom.setAttribute("normal", toPlainFloat(n, 3));
    }
    this.refreshArrays();

    // BVH prima dei gruppi: il BVH riordina (o crea) l'indice dei triangoli
    this.bvh = new MeshBVH(geom);
    geom.boundsTree = this.bvh;
    mesh.raycast = acceleratedRaycast;

    const count = this.pos.length / 3;

    // ---- saldatura dei vertici co-locati (quantizzazione relativa al bbox)
    geom.computeBoundingBox();
    const diag = geom.boundingBox!.getSize(new THREE.Vector3()).length() || 1;
    const q = 1 / (diag * 1e-6);
    const keyToGroup = new Map<string, number>();
    this.vertexGroup = new Int32Array(count);
    let groups = 0;
    for (let i = 0; i < count; i++) {
      const key = `${Math.round(this.pos[i * 3] * q)},${Math.round(this.pos[i * 3 + 1] * q)},${Math.round(this.pos[i * 3 + 2] * q)}`;
      let g = keyToGroup.get(key);
      if (g === undefined) {
        g = groups++;
        keyToGroup.set(key, g);
      }
      this.vertexGroup[i] = g;
    }
    this.groupCount = groups;

    this.groupStart = new Int32Array(groups + 1);
    for (let i = 0; i < count; i++) this.groupStart[this.vertexGroup[i] + 1]++;
    for (let g = 0; g < groups; g++) this.groupStart[g + 1] += this.groupStart[g];
    this.groupMembers = new Int32Array(count);
    const fill = this.groupStart.slice(0, groups);
    for (let i = 0; i < count; i++) this.groupMembers[fill[this.vertexGroup[i]]++] = i;

    // ---- adiacenza tra gruppi dagli spigoli dei triangoli
    const index = geom.index!.array;
    const deg = new Int32Array(groups + 1);
    for (let t = 0; t < index.length; t += 3) {
      const a = this.vertexGroup[index[t]];
      const b = this.vertexGroup[index[t + 1]];
      const c = this.vertexGroup[index[t + 2]];
      deg[a + 1] += 2;
      deg[b + 1] += 2;
      deg[c + 1] += 2;
    }
    for (let g = 0; g < groups; g++) deg[g + 1] += deg[g];
    const raw = new Int32Array(deg[groups]);
    const rawFill = deg.slice(0, groups);
    const push = (from: number, to: number) => {
      if (from !== to) raw[rawFill[from]++] = to;
    };
    for (let t = 0; t < index.length; t += 3) {
      const a = this.vertexGroup[index[t]];
      const b = this.vertexGroup[index[t + 1]];
      const c = this.vertexGroup[index[t + 2]];
      push(a, b); push(a, c);
      push(b, a); push(b, c);
      push(c, a); push(c, b);
    }
    // compatta togliendo i duplicati (ogni spigolo interno compare due volte)
    const mark = new Int32Array(groups).fill(-1);
    this.nbStart = new Int32Array(groups + 1);
    const compact: number[] = [];
    for (let g = 0; g < groups; g++) {
      for (let k = deg[g]; k < rawFill[g]; k++) {
        const nb = raw[k];
        if (mark[nb] === g) continue;
        mark[nb] = g;
        compact.push(nb);
      }
      this.nbStart[g + 1] = compact.length;
    }
    this.nbList = Int32Array.from(compact);

    // ---- triangoli per gruppo
    this.triStart = new Int32Array(groups + 1);
    for (let t = 0; t < index.length; t++) this.triStart[this.vertexGroup[index[t]] + 1]++;
    for (let g = 0; g < groups; g++) this.triStart[g + 1] += this.triStart[g];
    this.triList = new Int32Array(index.length);
    const triFill = this.triStart.slice(0, groups);
    for (let t = 0; t < index.length; t++) {
      this.triList[triFill[this.vertexGroup[index[t]]]++] = (t / 3) | 0;
    }

    this.groupNormal = new Float32Array(groups * 3);
    this.stamp = new Int32Array(groups);
    this.touched = new Uint8Array(groups);
    this.updateGroupNormals(true);
  }

  private refreshArrays() {
    // dopo setAttribute gli array cambiano: rileggo i riferimenti
    this.pos = (this.geometry.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
    this.nor = (this.geometry.getAttribute("normal") as THREE.BufferAttribute).array as Float32Array;
  }

  /** posizione rappresentativa del gruppo (tutti i membri coincidono) */
  private gx(g: number) { return this.pos[this.groupMembers[this.groupStart[g]] * 3]; }
  private gy(g: number) { return this.pos[this.groupMembers[this.groupStart[g]] * 3 + 1]; }
  private gz(g: number) { return this.pos[this.groupMembers[this.groupStart[g]] * 3 + 2]; }

  private setGroup(g: number, x: number, y: number, z: number) {
    for (let k = this.groupStart[g]; k < this.groupStart[g + 1]; k++) {
      const v = this.groupMembers[k] * 3;
      this.pos[v] = x;
      this.pos[v + 1] = y;
      this.pos[v + 2] = z;
    }
    if (!this.touched[g]) {
      this.touched[g] = 1;
      this.hasTouched = true;
    }
  }

  /**
   * Normale media di ogni gruppo. Con writeBack i membri ricevono la normale
   * media: niente cuciture di luce sui punti saldati che sono stati scolpiti.
   */
  private updateGroupNormals(all: boolean, writeBack = false) {
    const gn = this.groupNormal;
    for (let g = 0; g < this.groupCount; g++) {
      if (!all && !this.touched[g]) continue;
      let x = 0, y = 0, z = 0;
      for (let k = this.groupStart[g]; k < this.groupStart[g + 1]; k++) {
        const v = this.groupMembers[k] * 3;
        x += this.nor[v]; y += this.nor[v + 1]; z += this.nor[v + 2];
      }
      const len = Math.hypot(x, y, z) || 1;
      x /= len; y /= len; z /= len;
      gn[g * 3] = x; gn[g * 3 + 1] = y; gn[g * 3 + 2] = z;
      if (writeBack) {
        for (let k = this.groupStart[g]; k < this.groupStart[g + 1]; k++) {
          const v = this.groupMembers[k] * 3;
          this.nor[v] = x; this.nor[v + 1] = y; this.nor[v + 2] = z;
        }
      }
    }
  }

  /** Gruppi entro il raggio rivolti verso il tocco; riempie this.sel/selFall. */
  private gather(center: THREE.Vector3, radius: number, facing: THREE.Vector3, minDot: number) {
    this.sel.length = 0;
    this.selFall.length = 0;
    const id = ++this.stampId;
    const sphere = new THREE.Sphere(center, radius);
    const r2 = radius * radius;
    const index = this.geometry.index!.array;
    this.bvh.shapecast({
      intersectsBounds: (box) => (sphere.intersectsBox(box) ? INTERSECTED : NOT_INTERSECTED),
      intersectsTriangle: (_tri, triIndex) => {
        for (let c = 0; c < 3; c++) {
          const g = this.vertexGroup[index[triIndex * 3 + c]];
          if (this.stamp[g] === id) continue;
          this.stamp[g] = id;
          const dx = this.gx(g) - center.x;
          const dy = this.gy(g) - center.y;
          const dz = this.gz(g) - center.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= r2) continue;
          const dot =
            this.groupNormal[g * 3] * facing.x +
            this.groupNormal[g * 3 + 1] * facing.y +
            this.groupNormal[g * 3 + 2] * facing.z;
          if (dot < minDot) continue;
          this.sel.push(g);
          this.selFall.push(smoothFalloff(Math.sqrt(d2), radius));
        }
        return false;
      },
    });
  }

  /** Normale d'area pesata col falloff (usa la selezione corrente). */
  private areaNormal(fallback: THREE.Vector3): THREE.Vector3 {
    const out = new THREE.Vector3();
    for (let s = 0; s < this.sel.length; s++) {
      const g = this.sel[s];
      const f = this.selFall[s];
      out.x += this.groupNormal[g * 3] * f;
      out.y += this.groupNormal[g * 3 + 1] * f;
      out.z += this.groupNormal[g * 3 + 2] * f;
    }
    return out.lengthSq() > 1e-12 ? out.normalize() : fallback.clone().normalize();
  }

  /** Normale d'area nel punto indicato (per catturare il piano di "appiattisci"). */
  sampleAreaNormal(center: THREE.Vector3, radius: number, hitNormal: THREE.Vector3): THREE.Vector3 {
    this.gather(center, radius, hitNormal, 0);
    return this.areaNormal(hitNormal);
  }

  /** Applica una pennellata. Ritorna true se ha mosso qualcosa. */
  applyDab(dab: Dab): boolean {
    const { mode, center, radius, strength } = dab;
    const hitN = dab.hitNormal.clone().normalize();
    // il leviga accetta anche i punti di taglio (bordi), gli altri solo il lato toccato
    this.gather(center, radius, hitN, mode === "smooth" ? -0.25 : 0.0);
    const n = this.sel.length;
    if (n === 0) return false;

    const step = radius * strength;
    if (mode === "raise" || mode === "lower") {
      const an = this.areaNormal(hitN);
      const d = (mode === "raise" ? 1 : -1) * step * 0.06;
      for (let s = 0; s < n; s++) {
        const g = this.sel[s];
        const k = d * this.selFall[s];
        this.setGroup(g, this.gx(g) + an.x * k, this.gy(g) + an.y * k, this.gz(g) + an.z * k);
      }
    } else if (mode === "inflate") {
      const d = step * 0.05;
      for (let s = 0; s < n; s++) {
        const g = this.sel[s];
        const k = d * this.selFall[s];
        this.setGroup(
          g,
          this.gx(g) + this.groupNormal[g * 3] * k,
          this.gy(g) + this.groupNormal[g * 3 + 1] * k,
          this.gz(g) + this.groupNormal[g * 3 + 2] * k,
        );
      }
    } else if (mode === "smooth") {
      // Taubin λ|μ: un passo che leviga e uno, di segno opposto, che recupera
      // il volume. Lo smooth laplaciano semplice "sgonfia" le forme a ogni passata.
      const lambda = 0.2 + 0.4 * strength;
      const mu = -(lambda + 0.03);
      this.laplacianPass(lambda);
      this.laplacianPass(mu);
    } else if (mode === "pinch") {
      // verso il centro, ma solo nel piano tangente: stringe senza bucare
      const an = this.areaNormal(hitN);
      const amount = 0.12 * strength;
      for (let s = 0; s < n; s++) {
        const g = this.sel[s];
        let dx = center.x - this.gx(g);
        let dy = center.y - this.gy(g);
        let dz = center.z - this.gz(g);
        const along = dx * an.x + dy * an.y + dz * an.z;
        dx -= an.x * along; dy -= an.y * along; dz -= an.z * along;
        const t = amount * this.selFall[s];
        this.setGroup(g, this.gx(g) + dx * t, this.gy(g) + dy * t, this.gz(g) + dz * t);
      }
    } else if (mode === "flatten") {
      const plane = dab.plane;
      if (!plane) return false;
      const pn = plane.normal;
      const amount = 0.25 + 0.5 * strength;
      for (let s = 0; s < n; s++) {
        const g = this.sel[s];
        const x = this.gx(g), y = this.gy(g), z = this.gz(g);
        const side = (x - plane.point.x) * pn.x + (y - plane.point.y) * pn.y + (z - plane.point.z) * pn.z;
        const t = Math.min(1, amount * this.selFall[s]);
        this.setGroup(g, x - pn.x * side * t, y - pn.y * side * t, z - pn.z * side * t);
      }
    }

    (this.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    this.bvh.refit();
    return true;
  }

  /**
   * Ricalcola le normali solo nella zona scolpita (gruppi toccati + vicini),
   * come media delle facce adiacenti: le normali originali del resto del
   * modello restano intatte e i punti saldati non mostrano cuciture di luce.
   */
  updateNormals(final: boolean) {
    if (!this.hasTouched) return;
    const id = ++this.stampId;
    const affected: number[] = [];
    for (let g = 0; g < this.groupCount; g++) {
      if (!this.touched[g]) continue;
      if (this.stamp[g] !== id) { this.stamp[g] = id; affected.push(g); }
      for (let k = this.nbStart[g]; k < this.nbStart[g + 1]; k++) {
        const nb = this.nbList[k];
        if (this.stamp[nb] !== id) { this.stamp[nb] = id; affected.push(nb); }
      }
    }
    const index = this.geometry.index!.array;
    const P = this.pos;
    for (const g of affected) {
      let x = 0, y = 0, z = 0;
      for (let k = this.triStart[g]; k < this.triStart[g + 1]; k++) {
        const t = this.triList[k] * 3;
        const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
        const abx = P[b] - P[a], aby = P[b + 1] - P[a + 1], abz = P[b + 2] - P[a + 2];
        const acx = P[c] - P[a], acy = P[c + 1] - P[a + 1], acz = P[c + 2] - P[a + 2];
        // prodotto vettoriale non normalizzato = pesatura per area
        x += aby * acz - abz * acy;
        y += abz * acx - abx * acz;
        z += abx * acy - aby * acx;
      }
      const len = Math.hypot(x, y, z);
      if (len < 1e-20) continue;
      x /= len; y /= len; z /= len;
      this.groupNormal[g * 3] = x; this.groupNormal[g * 3 + 1] = y; this.groupNormal[g * 3 + 2] = z;
      for (let k = this.groupStart[g]; k < this.groupStart[g + 1]; k++) {
        const v = this.groupMembers[k] * 3;
        this.nor[v] = x; this.nor[v + 1] = y; this.nor[v + 2] = z;
      }
    }
    (this.geometry.getAttribute("normal") as THREE.BufferAttribute).needsUpdate = true;
    if (final) {
      this.geometry.computeBoundingSphere();
      this.geometry.computeBoundingBox();
      this.touched.fill(0);
      this.hasTouched = false;
    }
  }

  /** Un passo laplaciano (Jacobi) sui gruppi selezionati, pesato col falloff. */
  private laplacianPass(factor: number) {
    const n = this.sel.length;
    const target = new Float32Array(n * 3);
    for (let s = 0; s < n; s++) {
      const g = this.sel[s];
      const a = this.nbStart[g];
      const b = this.nbStart[g + 1];
      if (b === a) {
        target[s * 3] = this.gx(g); target[s * 3 + 1] = this.gy(g); target[s * 3 + 2] = this.gz(g);
        continue;
      }
      let x = 0, y = 0, z = 0;
      for (let k = a; k < b; k++) {
        const nb = this.nbList[k];
        x += this.gx(nb); y += this.gy(nb); z += this.gz(nb);
      }
      const inv = 1 / (b - a);
      target[s * 3] = x * inv; target[s * 3 + 1] = y * inv; target[s * 3 + 2] = z * inv;
    }
    for (let s = 0; s < n; s++) {
      const g = this.sel[s];
      const t = factor * this.selFall[s];
      const x = this.gx(g), y = this.gy(g), z = this.gz(g);
      this.setGroup(
        g,
        x + (target[s * 3] - x) * t,
        y + (target[s * 3 + 1] - y) * t,
        z + (target[s * 3 + 2] - z) * t,
      );
    }
  }

  // ---- cronologia ----

  snapshot(): { positions: Float32Array; normals: Float32Array } {
    return { positions: this.pos.slice(), normals: this.nor.slice() };
  }

  restore(snap: { positions: Float32Array; normals: Float32Array }) {
    if (snap.positions.length !== this.pos.length || snap.normals.length !== this.nor.length) return;
    this.pos.set(snap.positions);
    this.nor.set(snap.normals);
    (this.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute("normal") as THREE.BufferAttribute).needsUpdate = true;
    this.bvh.refit();
    this.updateGroupNormals(true);
    this.touched.fill(0);
    this.hasTouched = false;
    this.geometry.computeBoundingSphere();
    this.geometry.computeBoundingBox();
  }

  dispose() {
    this.geometry.boundsTree = undefined;
  }
}

// estensione dei tipi di three per il campo boundsTree usato da three-mesh-bvh
declare module "three" {
  interface BufferGeometry {
    boundsTree?: MeshBVH;
  }
}
