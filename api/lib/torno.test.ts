import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildMesh } from "./glb";
import { analyzePrintability } from "../../src/three/printCheck";

function shape(W: number, H: number, half: (v: number) => number) {
  const heights = new Float32Array(W * H).fill(0.5);
  const mask = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) {
    const v = j / (H - 1);
    const h = half(v);
    for (let i = 0; i < W; i++) {
      const u = i / (W - 1) - 0.5;
      if (Math.abs(u) < h && v > 0.05 && v < 0.95) mask[j * W + i] = 1;
    }
  }
  return { heights, mask };
}

/** volume con segno (> 0 se le facce guardano fuori) e spigoli orientati male */
function orientation(pos: Float32Array, idx: Uint32Array) {
  const key = (i: number) => `${pos[i * 3].toFixed(5)},${pos[i * 3 + 1].toFixed(5)},${pos[i * 3 + 2].toFixed(5)}`;
  const id = new Map<string, number>();
  const w = (i: number) => {
    const k = key(i);
    if (!id.has(k)) id.set(k, id.size);
    return id.get(k)!;
  };
  const directed = new Map<string, number>();
  let vol = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
    const A = new THREE.Vector3().fromArray(pos, a * 3), B = new THREE.Vector3().fromArray(pos, b * 3), C = new THREE.Vector3().fromArray(pos, c * 3);
    vol += A.dot(B.clone().cross(C)) / 6;
    const ids = [w(a), w(b), w(c)];
    if (new Set(ids).size < 3) continue;
    for (let e = 0; e < 3; e++) {
      const k = `${ids[e]}>${ids[(e + 1) % 3]}`;
      directed.set(k, (directed.get(k) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const n of directed.values()) if (n > 1) bad++;
  return { vol, bad };
}

function report(half: (v: number) => number) {
  const { heights, mask } = shape(128, 160, half);
  const m = buildMesh({ mode: "torno", width: 128, height: 160, heights, depth: 0.5, invert: false, mask });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  return { ...analyzePrintability(new THREE.Mesh(g)), ...orientation(m.positions, m.indices) };
}

describe("modalità torno: sempre stampabile", () => {
  it("vaso aperto sopra", () => {
    const r = report((v) => 0.25 + 0.12 * Math.sin(v * Math.PI));
    expect(r.watertight).toBe(true);
    expect(r.bad).toBe(0);
    expect(r.vol).toBeGreaterThan(0);
  });
  it("coppa svasata", () => {
    expect(report((v) => 0.4 - 0.3 * v).watertight).toBe(true);
  });
  it("bottiglia con collo stretto: collo pieno, cavità chiusa", () => {
    const r = report((v) => (v < 0.35 ? 0.03 : 0.3));
    expect(r.nonManifoldEdges).toBe(0);
    expect(r.openEdges).toBe(0);
    expect(r.bad).toBe(0); // facce orientate in modo coerente
    expect(r.vol).toBeGreaterThan(0);
  });
});
