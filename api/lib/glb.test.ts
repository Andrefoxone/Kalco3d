import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildMesh } from "./glb";
import { analyzePrintability } from "../../src/three/printCheck";

function toMesh(m: ReturnType<typeof buildMesh>) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  return new THREE.Mesh(g);
}

/** sagoma irregolare con angoli a scaletta (come una foto reale) */
function blob(W: number, H: number) {
  const heights = new Float32Array(W * H);
  const mask = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const x = i / (W - 1) - 0.5, y = j / (H - 1) - 0.5;
      const r = Math.hypot(x * 1.3, y) + 0.04 * Math.sin(Math.atan2(y, x) * 7);
      if (r < 0.38) {
        mask[j * W + i] = 1;
        heights[j * W + i] = 1 - r / 0.38;
      }
    }
  }
  return { heights, mask };
}

describe("buildMesh volume chiuso", () => {
  it("il rilievo con fronte/retro è davvero chiuso (stampabile)", () => {
    for (const [W, H] of [[48, 48], [97, 131], [160, 200]]) {
      const { heights, mask } = blob(W, H);
      const m = buildMesh({ mode: "rilievo", width: W, height: H, heights, depth: 0.4, invert: false, mask, solid: true });
      const r = analyzePrintability(toMesh(m));
      expect(r.openEdges, `${W}x${H}`).toBe(0);
      expect(r.nonManifoldEdges, `${W}x${H}`).toBe(0);
    }
  });
  it("senza volume chiuso resta un guscio aperto (atteso)", () => {
    const { heights, mask } = blob(48, 48);
    const m = buildMesh({ mode: "rilievo", width: 48, height: 48, heights, depth: 0.4, invert: false, mask, solid: false });
    expect(analyzePrintability(toMesh(m)).openEdges).toBeGreaterThan(0);
  });
});
