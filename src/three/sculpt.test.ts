import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildMesh } from "../../api/lib/glb";
import { SculptTarget, type SculptMode } from "./sculpt";

/** Disco "volume chiuso" generato dalla stessa pipeline del server. */
function solidDisc(W = 48, H = 48) {
  const heights = new Float32Array(W * H);
  const mask = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const dx = (i - W / 2) / (W / 2);
      const dy = (j - H / 2) / (H / 2);
      const r = Math.hypot(dx, dy);
      if (r < 0.8) {
        mask[j * W + i] = 1;
        heights[j * W + i] = Math.sqrt(1 - (r / 0.8) ** 2);
      }
    }
  }
  const built = buildMesh({ mode: "rilievo", width: W, height: H, heights, depth: 0.3, invert: false, mask, solid: true });
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(built.positions.slice(), 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(built.normals.slice(), 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(built.uvs.slice(), 2));
  geom.setIndex(new THREE.BufferAttribute(built.indices.slice(), 1));
  return new THREE.Mesh(geom, new THREE.MeshStandardMaterial());
}

/** Coppie di vertici distinti che all'inizio coincidono (cuciture). */
function coincidentPairs(pos: Float32Array): [number, number][] {
  const seen = new Map<string, number>();
  const pairs: [number, number][] = [];
  for (let i = 0; i < pos.length / 3; i++) {
    const k = `${pos[i * 3].toFixed(6)},${pos[i * 3 + 1].toFixed(6)},${pos[i * 3 + 2].toFixed(6)}`;
    const f = seen.get(k);
    if (f === undefined) seen.set(k, i);
    else pairs.push([f, i]);
  }
  return pairs;
}

function maxGap(pos: Float32Array, pairs: [number, number][]) {
  let m = 0;
  for (const [a, b] of pairs) {
    m = Math.max(m, Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]));
  }
  return m;
}

/** Sfera con cucitura UV (vertici duplicati), come i GLB dei motori AI. */
function seamSphere() {
  return new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.MeshStandardMaterial());
}
/** la cucitura di SphereGeometry è sul lato -X */
const SEAM = { c: new THREE.Vector3(-1, 0, 0), n: new THREE.Vector3(-1, 0, 0) };

/** vertici usati da almeno un triangolo */
function usedVertices(mesh: THREE.Mesh) {
  const idx = mesh.geometry.index!.array;
  const used = new Uint8Array(mesh.geometry.getAttribute("position").count);
  for (let i = 0; i < idx.length; i++) used[idx[i]] = 1;
  return used;
}

/** Punto sul perimetro della sagoma (parete laterale del volume chiuso). */
function rimPoint(mesh: THREE.Mesh) {
  const pos = mesh.geometry.getAttribute("position").array as Float32Array;
  let best = 0;
  for (let i = 0; i < pos.length / 3; i++) {
    if (Math.abs(pos[i * 3 + 2]) < 0.02 && pos[i * 3] > pos[best * 3]) best = i;
  }
  return new THREE.Vector3(pos[best * 3], pos[best * 3 + 1], 0);
}

describe("SculptTarget", () => {
  it("salda i vertici della cucitura UV: nessuna crepa dopo la scultura", () => {
    const modes: SculptMode[] = ["raise", "lower", "inflate", "smooth", "pinch"];
    for (const mode of modes) {
      const mesh = seamSphere();
      const pos0 = (mesh.geometry.getAttribute("position").array as Float32Array).slice();
      const pairs = coincidentPairs(pos0);
      expect(pairs.length).toBeGreaterThan(20);
      const t = new SculptTarget(mesh);
      for (let k = 0; k < 10; k++) {
        t.applyDab({ mode, center: SEAM.c, hitNormal: SEAM.n, radius: 0.5, strength: 1 });
      }
      t.updateNormals(true);
      const pos = mesh.geometry.getAttribute("position").array as Float32Array;
      expect(maxGap(pos, pairs), mode).toBe(0);
    }
  });

  it("le normali dei punti saldati restano identiche (niente cucitura di luce)", () => {
    const mesh = seamSphere();
    const pairs = coincidentPairs((mesh.geometry.getAttribute("position").array as Float32Array).slice());
    const t = new SculptTarget(mesh);
    t.applyDab({ mode: "raise", center: SEAM.c, hitNormal: SEAM.n, radius: 0.5, strength: 1 });
    t.updateNormals(true);
    const nor = mesh.geometry.getAttribute("normal").array as Float32Array;
    const posNow = mesh.geometry.getAttribute("position").array as Float32Array;
    // solo le coppie nella zona toccata vengono unificate: controllo quelle vicine al pennello
    const c = SEAM.c;
    for (const [a, b] of pairs) {
      const d = Math.hypot(posNow[a * 3] - c.x, posNow[a * 3 + 1] - c.y, posNow[a * 3 + 2] - c.z);
      if (d > 0.3) continue;
      expect(Math.abs(nor[a * 3] - nor[b * 3]) + Math.abs(nor[a * 3 + 2] - nor[b * 3 + 2])).toBeLessThan(1e-6);
    }
  });

  it("alzando il fronte il retro non si muove", () => {
    const mesh = solidDisc();
    const pos0 = (mesh.geometry.getAttribute("position").array as Float32Array).slice();
    const t = new SculptTarget(mesh);
    // centro del fronte: punto con z massima
    let top = 0;
    for (let i = 0; i < pos0.length / 3; i++) if (pos0[i * 3 + 2] > pos0[top * 3 + 2]) top = i;
    const c = new THREE.Vector3(pos0[top * 3], pos0[top * 3 + 1], pos0[top * 3 + 2]);
    for (let k = 0; k < 5; k++) {
      t.applyDab({ mode: "raise", center: c, hitNormal: new THREE.Vector3(0, 0, 1), radius: 1.2, strength: 1 });
    }
    const pos = mesh.geometry.getAttribute("position").array as Float32Array;
    let backMoved = 0;
    let frontMoved = 0;
    for (let i = 0; i < pos.length / 3; i++) {
      const dz = pos[i * 3 + 2] - pos0[i * 3 + 2];
      if (pos0[i * 3 + 2] < -1e-6) backMoved = Math.max(backMoved, Math.abs(dz));
      if (pos0[i * 3 + 2] > 1e-6) frontMoved = Math.max(frontMoved, dz);
    }
    expect(frontMoved).toBeGreaterThan(0.01);
    expect(backMoved).toBe(0);
  });

  it("leviga riduce il rumore senza appiattire la cupola", () => {
    const mesh = solidDisc();
    const attr = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const clean = arr.slice();
    const used = usedVertices(mesh);
    // rumore deterministico sul fronte
    for (let i = 0; i < arr.length / 3; i++) {
      if (used[i] && arr[i * 3 + 2] > 0.02) arr[i * 3 + 2] += (((i * 7919) % 13) / 13 - 0.5) * 0.06;
    }
    const t = new SculptTarget(mesh);
    const noise = () => {
      let s = 0, n = 0;
      for (let i = 0; i < arr.length / 3; i++) {
        if (used[i] && clean[i * 3 + 2] > 0.15) { s += Math.abs(arr[i * 3 + 2] - clean[i * 3 + 2]); n++; }
      }
      return s / n;
    };
    const peak = () => { let m = 0; for (let i = 0; i < arr.length / 3; i++) m = Math.max(m, arr[i * 3 + 2]); return m; };
    const n0 = noise();
    let p0 = 0; for (let i = 0; i < clean.length / 3; i++) p0 = Math.max(p0, clean[i * 3 + 2]);
    for (let k = 0; k < 4; k++) {
      t.applyDab({ mode: "smooth", center: new THREE.Vector3(0, 0, p0), hitNormal: new THREE.Vector3(0, 0, 1), radius: 3, strength: 1 });
    }
    expect(noise()).toBeLessThan(n0 * 0.5);
    expect(peak()).toBeGreaterThan(p0 * 0.85);
  });

  it("restore riporta posizioni e normali esattamente allo stato iniziale", () => {
    const mesh = solidDisc();
    const t = new SculptTarget(mesh);
    const snap = t.snapshot();
    t.applyDab({ mode: "inflate", center: rimPoint(mesh), hitNormal: new THREE.Vector3(1, 0, 0), radius: 0.5, strength: 1 });
    t.updateNormals(true);
    t.restore(snap);
    expect(Array.from(mesh.geometry.getAttribute("position").array)).toEqual(Array.from(snap.positions));
    expect(Array.from(mesh.geometry.getAttribute("normal").array)).toEqual(Array.from(snap.normals));
  });

  it("gestisce geometrie non indicizzate e attributi interleaved", () => {
    const g = new THREE.SphereGeometry(1, 24, 16).toNonIndexed();
    const p = g.getAttribute("position") as THREE.BufferAttribute;
    const n = g.getAttribute("normal") as THREE.BufferAttribute;
    const ib = new THREE.InterleavedBuffer(new Float32Array(p.count * 6), 6);
    for (let i = 0; i < p.count; i++) {
      ib.array[i * 6] = p.getX(i); ib.array[i * 6 + 1] = p.getY(i); ib.array[i * 6 + 2] = p.getZ(i);
      ib.array[i * 6 + 3] = n.getX(i); ib.array[i * 6 + 4] = n.getY(i); ib.array[i * 6 + 5] = n.getZ(i);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.InterleavedBufferAttribute(ib, 3, 0));
    geom.setAttribute("normal", new THREE.InterleavedBufferAttribute(ib, 3, 3));
    const mesh = new THREE.Mesh(geom);
    const pairs = coincidentPairs(Float32Array.from({ length: p.count * 3 }, (_, k) => (k % 3 === 0 ? p.getX((k / 3) | 0) : k % 3 === 1 ? p.getY((k / 3) | 0) : p.getZ((k / 3) | 0))));
    const t = new SculptTarget(mesh);
    for (let k = 0; k < 5; k++) {
      t.applyDab({ mode: "raise", center: new THREE.Vector3(1, 0, 0), hitNormal: new THREE.Vector3(1, 0, 0), radius: 0.6, strength: 1 });
    }
    t.updateNormals(true);
    const pos = mesh.geometry.getAttribute("position").array as Float32Array;
    expect(maxGap(pos, pairs)).toBe(0);
  });
});
